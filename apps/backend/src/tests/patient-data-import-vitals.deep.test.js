// Audit 2026-08-10 R8 — real-Postgres pins for FHIR observation import
// (src/services/import/patientDataImport.js):
//
//   * an import must NEVER overwrite a charted vitals row in place. The old
//     path ran a source-blind ±1-minute dedupe and UPDATEd the matched
//     (typically staff-charted) row — no timeline event, no audit row — and
//     its INSERT branch omitted source, so imports masqueraded as
//     staff-charted.
//   * imports now route through recordVitals: the new row carries
//     source 'fhir', and the canonical clinical timeline invariant holds
//     (detail row + one clinical_timeline_events row + one
//     clinical_audit_events row in the same transaction).
//   * dedupe is idempotency-only: a re-import of the same observation is
//     skipped against the prior 'fhir'-sourced row, never against charted
//     data.
//
// Self-skips without a DB.

import crypto from 'node:crypto';

import { jest } from '@jest/globals';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  importFhirBundle as importFhirBundleWithAuthority,
  importFhirVitalObservation,
  reconcilePendingFhirVitalEffects,
} from '../services/import/patientDataImport.js';
import { verifyDeviceVitals } from '../services/emr/deviceVitalsService.js';
import { correctVitals } from '../services/emr/vitalsChartService.js';
import { clinicalImportSha256 } from '../services/import/clinicalImportReceiptService.js';
import {
  lockTenantPatientMergeExecutionExclusive,
  PATIENT_MERGE_STABILITY_TIMEOUT_MS,
} from '../utils/patientMergeStabilityLock.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT = '00000000-0000-4000-8000-000000000001'; // literal default tenant
const PATIENT = '00000000-0000-4000-8000-0000000f4151';
const IMPORTER = '00000000-0000-4000-8000-0000000f4152';
const VERIFYING_CLINICIAN = '00000000-0000-4000-8000-0000000f4155';
const MERGED_PATIENT_ALIAS = '00000000-0000-4000-8000-0000000f4153';
const MERGE_RACE_PATIENT = '00000000-0000-4000-8000-0000000f4154';
const CLINICAL_IMPORT_SOURCE_SYSTEM = 'jest-fhir-vitals-deep';
const ACCESS_POLICY = Object.freeze({
  access_decision: 'allow',
  access_source: 'test_fixture_explicit_grant',
  policy_code: 'patient.record.upload',
  policy_version: '1',
  policy_hash: clinicalImportSha256('test-manual-clinical-import-policy-v1'),
  reason: 'Explicit test-only clinical import access evidence',
});
let testFacilityId = null;
let importDocumentSequence = 0;
const authorityGrants = new Map();

async function clinicalImportQuery(tenantId, sql, ...params) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

function bundleWithSourceAuthor(bundle, importedBy) {
  return {
    ...bundle,
    entry: (bundle.entry || []).map((entry) => {
      const resource = entry?.resource;
      if (resource?.resourceType !== 'Observation' || resource.performer?.length) return entry;
      return {
        ...entry,
        resource: {
          ...resource,
          performer: [{ reference: `Practitioner/${importedBy}` }],
        },
      };
    }),
  };
}

async function ensureClinicalImportGrant({ tenantId, patientUid, importedBy }) {
  const scope = `${tenantId}:${patientUid}:${importedBy}:${CLINICAL_IMPORT_SOURCE_SYSTEM}`;
  if (!authorityGrants.has(scope)) {
    const grantId = crypto.randomUUID();
    const ownerEvidenceRef = `test://clinical-import/fhir-vitals/${grantId}`;
    authorityGrants.set(scope, setTenantTx(tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_import_authority_events
           (tenant_id, grant_id, event_type, patient_uid, facility_id,
            actor_uid, actor_role, source_system, document_formats,
            valid_from, valid_until, owner_evidence_ref, owner_evidence_sha256,
            recorded_by, reason, idempotency_key_sha256, contract_version)
         VALUES
           ($1::uuid, $2::uuid, 'GRANTED', $3::uuid, $4::int,
            $5::uuid, 'MEDICAL_RECORDS', $6, ARRAY['fhir_bundle']::text[],
            NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 day', $7, $8,
            $5::uuid, $9, $10, 1)`,
        tenantId,
        grantId,
        patientUid,
        testFacilityId,
        importedBy,
        CLINICAL_IMPORT_SOURCE_SYSTEM,
        ownerEvidenceRef,
        clinicalImportSha256(ownerEvidenceRef),
        `Explicit test grant for ${patientUid}`,
        clinicalImportSha256(`grant:${tenantId}:${grantId}`),
      );
      return grantId;
    }));
  }
  return authorityGrants.get(scope);
}

async function expectClinicalImportReceipt(result, authority) {
  const custody = await clinicalImportQuery(
    authority.tenantId,
    `SELECT document.authority_grant_id, document.raw_artifact_id,
            document.access_decision_evidence, document.source_author_evidence,
            raw.patient_uid, raw.source_facility_id, raw.actor_uid,
            raw.source_system, raw.source_document_id, raw.document_format,
            raw.raw_payload_sha256, raw.raw_payload_bytes::int AS raw_payload_bytes,
            raw.raw_content_type, raw.canonicalization_version,
            raw.canonical_payload_sha256, raw.signature_verification_status,
            raw.source_author_evidence AS raw_source_author_evidence
       FROM clinical_import_document_receipts AS document
       JOIN clinical_import_raw_artifacts AS raw
         ON raw.tenant_id=document.tenant_id AND raw.id=document.raw_artifact_id
      WHERE document.tenant_id=$1::uuid AND document.id=$2::uuid`,
    authority.tenantId,
    result.receipt_id,
  );
  expect(custody).toHaveLength(1);
  expect(custody[0]).toMatchObject({
    authority_grant_id: authority.authorityGrantId,
    patient_uid: authority.patientUid,
    source_facility_id: testFacilityId,
    actor_uid: authority.actorUid,
    source_system: CLINICAL_IMPORT_SOURCE_SYSTEM,
    source_document_id: authority.sourceDocumentId,
    document_format: 'fhir_bundle',
    raw_payload_sha256: crypto.createHash('sha256').update(authority.rawDocument).digest('hex'),
    raw_payload_bytes: authority.rawDocument.length,
    raw_content_type: 'application/fhir+json',
    canonicalization_version: 'exact-http-body+fhir-canonical-json-v1',
    canonical_payload_sha256: authority.sourcePayloadSha256,
    signature_verification_status: 'asserted_unverified',
  });
  expect(custody[0].raw_artifact_id).toEqual(expect.any(String));
  expect(custody[0].access_decision_evidence).toMatchObject({
    contract_version: 'clinical-import-access-decision-v1',
    decision: 'allow',
    authority_grant_id: authority.authorityGrantId,
    patient_uid: authority.patientUid,
    patient_access: ACCESS_POLICY,
  });
  expect(custody[0].source_author_evidence.authors).not.toHaveLength(0);
  expect(custody[0].raw_source_author_evidence).toEqual(custody[0].source_author_evidence);

  const persistedResources = await clinicalImportQuery(
    authority.tenantId,
    `SELECT id, source_resource_type, source_resource_id, source_resource_index,
            outcome, target_table, target_id
       FROM clinical_import_resource_receipts
      WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid
      ORDER BY source_resource_index`,
    authority.tenantId,
    result.receipt_id,
  );
  expect(result.resource_receipts).toEqual(persistedResources.map((resource) => ({
    ...resource,
    source_resource_index: Number(resource.source_resource_index),
  })));
  const failedReceiptIds = result.resource_receipts
    .filter(({ outcome }) => outcome === 'failed')
    .map(({ id }) => id)
    .sort();
  expect(result.reconciliation_items.map(({ resource_receipt_id: id }) => id).sort())
    .toEqual(failedReceiptIds);
  expect(result.reconciliation_items).toEqual(result.reconciliation_items.map((item) => ({
    ...item,
    opened_event_id: expect.any(String),
    status: 'OPENED',
  })));
  expect(result.errors).toHaveLength(Number(result.failed || 0));
  for (const partition of result.observationPartitions.filter((candidate) => (
    candidate.status === 'imported' && candidate.error
  ))) {
    expect(partition).toEqual(expect.objectContaining({
      error: 'FHIR vitals were committed, but clinical effects remain incomplete',
      errorCode: expect.any(String),
    }));
  }

  const reconciliation = await clinicalImportQuery(
    authority.tenantId,
    `SELECT
       (SELECT COUNT(*)::int FROM clinical_import_resource_receipts
         WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid
           AND outcome='failed') AS failed_resource_count,
       (SELECT COUNT(*)::int FROM clinical_import_reconciliation_items
         WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid) AS item_count,
       (SELECT COUNT(*)::int FROM clinical_import_reconciliation_events
         WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid
           AND event_type='OPENED') AS opened_event_count`,
    authority.tenantId,
    result.receipt_id,
  );
  const failed = Number(result.failed || 0);
  expect(reconciliation).toEqual([{
    failed_resource_count: failed,
    item_count: failed,
    opened_event_count: failed,
  }]);
}

async function expectClinicalImportRollback(tenantId, sourceDocumentId) {
  const rows = await clinicalImportQuery(
    tenantId,
    `SELECT
       (SELECT COUNT(*)::int FROM clinical_import_document_receipts
         WHERE tenant_id=$1::uuid AND source_system=$2 AND source_document_id=$3) AS document_count,
       (SELECT COUNT(*)::int FROM clinical_import_raw_artifacts
         WHERE tenant_id=$1::uuid AND source_system=$2 AND source_document_id=$3) AS raw_artifact_count,
       (SELECT COUNT(*)::int FROM clinical_import_resource_receipts
         WHERE tenant_id=$1::uuid AND document_receipt_id IN (
           SELECT id FROM clinical_import_document_receipts
            WHERE tenant_id=$1::uuid AND source_system=$2 AND source_document_id=$3
         )) AS resource_count,
       (SELECT COUNT(*)::int FROM clinical_import_reconciliation_items
         WHERE tenant_id=$1::uuid AND document_receipt_id IN (
           SELECT id FROM clinical_import_document_receipts
            WHERE tenant_id=$1::uuid AND source_system=$2 AND source_document_id=$3
         )) AS reconciliation_item_count,
       (SELECT COUNT(*)::int FROM clinical_import_reconciliation_events
         WHERE tenant_id=$1::uuid AND document_receipt_id IN (
           SELECT id FROM clinical_import_document_receipts
            WHERE tenant_id=$1::uuid AND source_system=$2 AND source_document_id=$3
         )) AS reconciliation_event_count`,
    tenantId,
    CLINICAL_IMPORT_SOURCE_SYSTEM,
    sourceDocumentId,
  );
  expect(rows).toEqual([{
    document_count: 0,
    raw_artifact_count: 0,
    resource_count: 0,
    reconciliation_item_count: 0,
    reconciliation_event_count: 0,
  }]);
}

async function importFhirBundle(bundle, importedBy, options = {}) {
  const authoritativeBundle = bundleWithSourceAuthor(bundle, importedBy);
  const patientReference = (authoritativeBundle.entry || [])
    .map(({ resource }) => resource?.subject?.reference || resource?.patient?.reference)
    .find(Boolean);
  const patientUid = options.authority?.patientUid
    || String(patientReference || '').replace('Patient/', '')
    || PATIENT;
  const patientRows = await query(
    `SELECT id FROM users WHERE tenant_id=$1::uuid AND uid=$2::uuid LIMIT 1`,
    options.tenantId || TENANT,
    patientUid,
  );
  if (!patientRows.length || !testFacilityId) throw new Error('FHIR deep-test receipt authority is unavailable');
  const authorityGrantId = await ensureClinicalImportGrant({
    tenantId: options.tenantId || TENANT,
    patientUid,
    importedBy,
  });
  const sourcePayloadSha256 = clinicalImportSha256(authoritativeBundle);
  const sourceDocumentId = `fhir-deep-${process.pid}-${++importDocumentSequence}`;
  const authority = {
    ...options.authority,
    patientUid,
    patientId: Number(patientRows[0].id),
    sourceSystem: CLINICAL_IMPORT_SOURCE_SYSTEM,
    sourceDocumentId,
    sourceFacilityId: testFacilityId,
    authorityGrantId,
    sourceSignatureSha256: clinicalImportSha256(`signature:${sourcePayloadSha256}`),
    sourcePayloadSha256,
    rawDocument: Buffer.from(JSON.stringify(authoritativeBundle), 'utf8'),
    rawContentType: 'application/fhir+json',
    accessDecisionEvidence: ACCESS_POLICY,
    revalidateAccess: async () => ACCESS_POLICY,
    actorUid: importedBy,
    actorRole: 'MEDICAL_RECORDS',
    ingestionMode: 'manual_medical_records',
    requestId: sourceDocumentId,
    tenantId: options.tenantId || TENANT,
  };
  const invocationAuthority = {
    ...authority,
    idempotencyKey: `fhir-deep:${sourceDocumentId}`,
  };
  if (typeof options.captureInvocation === 'function') {
    options.captureInvocation({ bundle: authoritativeBundle, authority: invocationAuthority });
  }
  let result;
  try {
    result = await importFhirBundleWithAuthority(authoritativeBundle, importedBy, {
      ...options,
      authority: invocationAuthority,
    });
  } catch (error) {
    await expectClinicalImportRollback(authority.tenantId, sourceDocumentId);
    throw error;
  }
  await expectClinicalImportReceipt(result, authority);
  if (options.autoVerifyClinicalVitals !== false) {
    const ids = [...new Set((result.observationPartitions || [])
      .filter(({ status }) => ['imported', 'deduplicated'].includes(status))
      .map(({ vitalsChartId }) => Number(vitalsChartId))
      .filter((id) => Number.isInteger(id) && id > 0))];
    for (const id of ids) {
      await verifyDeviceVitals(id, {
        actorUid: VERIFYING_CLINICIAN,
        actorRole: 'NURSING_STAFF',
        tenantId: options.tenantId || TENANT,
      });
    }
  }
  return result;
}

async function exec(sql, ...p) {
  return prisma.$executeRawUnsafe(sql, ...p);
}
async function query(sql, ...p) {
  const r = await prisma.$queryRawUnsafe(sql, ...p);
  return Array.isArray(r) ? r : [];
}

function observationId(prefix, effective) {
  return `${prefix}-${new Date(effective).getTime()}`;
}

function heartRateBundle(effective, value, {
  id = observationId('obs-hr', effective),
  status = 'final',
} = {}) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id,
        ...(status == null ? {} : { status }),
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: effective,
        valueQuantity: { value, unit: 'beats/minute' },
      },
    }],
  };
}

function heightBundle(effective, value, {
  id = observationId('obs-height', effective),
  code = 'cm',
  unit = 'centimetres',
} = {}) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id,
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8302-2' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: effective,
        valueQuantity: { value, code, unit },
      },
    }],
  };
}

function compositeNews2Bundle(effective, { idSuffix = '' } = {}) {
  const timestampSuffix = new Date(effective).getTime();
  const observations = [
    { id: 'obs-rr-crit', code: '9279-1', value: 26, unit: 'breaths/minute' },
    { id: 'obs-spo2-crit', code: '2708-6', value: 88, unit: '%' },
    { id: 'obs-sbp-crit', code: '8480-6', value: 88, unit: 'mmHg' },
    { id: 'obs-hr-crit', code: '8867-4', value: 132, unit: 'beats/minute' },
    { id: 'obs-temp-normal', code: '8310-5', value: 37, unit: 'Cel' },
  ];
  const memberEntries = observations.map(({ id, code, value, unit }) => ({
    resource: {
      resourceType: 'Observation',
      id: `${id}-${timestampSuffix}${idSuffix}`,
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code }] },
      subject: { reference: `Patient/${PATIENT}` },
      effectiveDateTime: effective,
      valueQuantity: { value, unit },
    },
  }));
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id: `obs-vitals-panel-${timestampSuffix}${idSuffix}`,
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '85353-1' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: effective,
        hasMember: memberEntries.map(({ resource }) => ({ reference: `Observation/${resource.id}` })),
        component: [{
          code: { coding: [{ system: 'http://loinc.org', code: '3151-8' }] },
          valueQuantity: {
            value: 0,
            system: 'http://unitsofmeasure.org',
            code: 'L/min',
          },
        }],
      },
    }, ...memberEntries],
  };
}

function ungroupedNews2Bundle(effective, { idSuffix = '' } = {}) {
  const bundle = compositeNews2Bundle(effective, { idSuffix });
  return {
    ...bundle,
    entry: bundle.entry.slice(1),
  };
}

function componentAndFahrenheitBundle(effective) {
  const timestampSuffix = new Date(effective).getTime();
  const bloodPressureId = `obs-bp-panel-${timestampSuffix}`;
  const temperatureId = `obs-temp-fahrenheit-${timestampSuffix}`;
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Observation',
          id: `obs-vitals-panel-${timestampSuffix}`,
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '85353-1' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: effective,
          hasMember: [bloodPressureId, temperatureId]
            .map((id) => ({ reference: `Observation/${id}` })),
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          id: bloodPressureId,
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: effective,
          component: [
            { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 118, unit: 'mmHg' } },
            { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 72, unit: 'mmHg' } },
          ],
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          id: temperatureId,
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: effective,
          valueQuantity: { value: 98.6, unit: 'degF' },
        },
      },
    ],
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS test_fhir_verification_news2_failure ON news2_scores`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS test_fhir_verification_news2_failure()`,
  ).catch(() => {});
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$queryRawUnsafe(
      `SELECT set_config('app.current_tenant_id', $1::text, true)`,
      TENANT,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_reconciliation_events
        WHERE tenant_id=$1::uuid AND document_receipt_id IN (
          SELECT id FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid AND source_system=$2
        )`,
      TENANT,
      CLINICAL_IMPORT_SOURCE_SYSTEM,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_reconciliation_items
        WHERE tenant_id=$1::uuid AND document_receipt_id IN (
          SELECT id FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid AND source_system=$2
        )`,
      TENANT,
      CLINICAL_IMPORT_SOURCE_SYSTEM,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_resource_receipts
        WHERE tenant_id=$1::uuid AND document_receipt_id IN (
          SELECT id FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid AND source_system=$2
        )`,
      TENANT,
      CLINICAL_IMPORT_SOURCE_SYSTEM,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_document_receipts
        WHERE tenant_id=$1::uuid AND source_system=$2`,
      TENANT,
      CLINICAL_IMPORT_SOURCE_SYSTEM,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_raw_artifacts
        WHERE tenant_id=$1::uuid AND source_system=$2`,
      TENANT,
      CLINICAL_IMPORT_SOURCE_SYSTEM,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_authority_events
        WHERE tenant_id=$1::uuid AND source_system=$2`,
      TENANT,
      CLINICAL_IMPORT_SOURCE_SYSTEM,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT,
      MERGE_RACE_PATIENT,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT,
      MERGE_RACE_PATIENT,
    );
  }).catch(() => {});
  authorityGrants.clear();
  await exec(
    `DELETE FROM news2_scores WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  await exec(
    `DELETE FROM clinical_alerts
      WHERE patient_id IN (SELECT id FROM users WHERE uid IN ($1::uuid, $2::uuid))`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  // Append-only guarded tables — test-DB role is a superuser (accepted escape).
  await exec(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  await exec(
    `DELETE FROM clinical_audit_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  await exec(`DELETE FROM fhir_vital_observation_set_resources WHERE tenant_id = $1::uuid`, TENANT).catch(() => {});
  await exec(
    `DELETE FROM fhir_vital_observation_sets WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  await exec(
    `DELETE FROM fhir_vital_observation_receipts WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  await exec(
    `DELETE FROM vitals_chart WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    MERGE_RACE_PATIENT,
  ).catch(() => {});
  await exec(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
    PATIENT,
    IMPORTER,
    MERGED_PATIENT_ALIAS,
    MERGE_RACE_PATIENT,
    VERIFYING_CLINICIAN,
  ).catch(() => {});
}

d('R8 — FHIR import never overwrites charted vitals (real Postgres)', () => {
  beforeAll(async () => {
    await cleanup();
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990333444', 'Import Test Patient', 'PATIENT', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, TENANT,
    );
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990333445', 'Import Test Clerk', 'MEDICAL_RECORDS', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      IMPORTER, TENANT,
    );
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990333448', 'Import Test Clinician', 'NURSING_STAFF', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      VERIFYING_CLINICIAN, TENANT,
    );
    const facilityRows = await query(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status)
       VALUES ($1::uuid, 'FHIR-DEEP', 'FHIR deep-test facility', 'active')
       ON CONFLICT (tenant_id, facility_code)
       DO UPDATE SET status='active'
       RETURNING id`,
      TENANT,
    );
    testFacilityId = Number(facilityRows[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('holds asserted-unverified manual FHIR vitals until one clinical verification activates effects', async () => {
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const bundle = heartRateBundle(observedAt, 180, { id: `held-${crypto.randomUUID()}` });
    let replayInvocation = null;
    const imported = await importFhirBundle(
      bundle,
      IMPORTER,
      {
        tenantId: TENANT,
        autoVerifyClinicalVitals: false,
        captureInvocation: (invocation) => { replayInvocation = invocation; },
      },
    );
    const vitalsId = Number(imported.observationPartitions[0].vitalsChartId);

    const before = await query(
      `SELECT vitals.device_verified,
              (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=vitals.id) AS news2_count,
              (SELECT COUNT(*)::int FROM clinical_alerts WHERE source_vitals_chart_id=vitals.id) AS alert_count,
              (SELECT event_status FROM clinical_timeline_events
                WHERE tenant_id=vitals.tenant_id AND source_table='vitals_chart'
                  AND source_id=vitals.id::text AND event_type='vitals.recorded'
                ORDER BY occurred_at, id LIMIT 1) AS canonical_status,
              (SELECT payload->>'verification_status' FROM clinical_timeline_events
                WHERE tenant_id=vitals.tenant_id AND source_table='vitals_chart'
                  AND source_id=vitals.id::text AND event_type='vitals.recorded'
                ORDER BY occurred_at, id LIMIT 1) AS verification_status,
              sets.news2_effects_completed_at,
              sets.anomaly_effects_completed_at
         FROM vitals_chart AS vitals
         JOIN fhir_vital_observation_sets AS sets
           ON sets.tenant_id=vitals.tenant_id AND sets.vitals_chart_id=vitals.id
        WHERE vitals.tenant_id=$1::uuid AND vitals.id=$2::int`,
      TENANT,
      vitalsId,
    );
    expect(before).toEqual([expect.objectContaining({
      device_verified: false,
      news2_count: 0,
      alert_count: 0,
      canonical_status: 'unverified',
      verification_status: 'asserted_unverified',
      news2_effects_completed_at: null,
      anomaly_effects_completed_at: null,
    })]);
    const exactReplay = await importFhirBundleWithAuthority(
      replayInvocation.bundle,
      IMPORTER,
      { tenantId: TENANT, authority: replayInvocation.authority },
    );
    expect(exactReplay).toMatchObject({ receipt_id: imported.receipt_id, replayed: true });
    await reconcilePendingFhirVitalEffects({ tenantId: TENANT, limit: 25 });
    const afterSweep = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=$1::int) AS news2_count,
         (SELECT COUNT(*)::int FROM clinical_alerts WHERE source_vitals_chart_id=$1::int) AS alert_count,
         sets.news2_effects_completed_at,
         sets.anomaly_effects_completed_at
       FROM fhir_vital_observation_sets AS sets
       WHERE sets.tenant_id=$2::uuid AND sets.vitals_chart_id=$1::int`,
      vitalsId,
      TENANT,
    );
    expect(afterSweep).toEqual([{
      news2_count: 0,
      alert_count: 0,
      news2_effects_completed_at: null,
      anomaly_effects_completed_at: null,
    }]);
    await expect(verifyDeviceVitals(vitalsId, {
      actorUid: IMPORTER,
      actorRole: 'MEDICAL_RECORDS',
      tenantId: TENANT,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FHIR_VITAL_VERIFIER_ROLE_REQUIRED' });

    await correctVitals(vitalsId, {
      corrected_by: VERIFYING_CLINICIAN,
      actor_role: 'NURSING_STAFF',
      tenantId: TENANT,
      heart_rate: 179,
    });
    const heldAfterCorrection = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=$1::int) AS news2_count,
         (SELECT COUNT(*)::int FROM clinical_alerts WHERE source_vitals_chart_id=$1::int) AS alert_count,
         (SELECT event_status FROM clinical_timeline_events
           WHERE tenant_id=$2::uuid AND source_table='vitals_chart'
             AND source_id=$1::text AND event_type='vitals.corrected'
           ORDER BY occurred_at DESC, id DESC LIMIT 1) AS correction_status`,
      vitalsId,
      TENANT,
    );
    expect(heldAfterCorrection).toEqual([{
      news2_count: 0,
      alert_count: 0,
      correction_status: 'unverified',
    }]);

    const verified = await verifyDeviceVitals(vitalsId, {
      actorUid: VERIFYING_CLINICIAN,
      actorRole: 'NURSING_STAFF',
      tenantId: TENANT,
    });
    expect(verified).toMatchObject({
      source: 'fhir',
      device_verified: true,
      verification_replayed: false,
      clinical_effects: { pendingEffects: [] },
    });
    const after = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=$1::int) AS news2_count,
         (SELECT COUNT(*)::int FROM clinical_alerts WHERE source_vitals_chart_id=$1::int) AS alert_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$2::uuid AND source_table='vitals_chart'
             AND source_id=$1::text AND event_type='vitals.fhir_verified') AS verification_events`,
      vitalsId,
      TENANT,
    );
    expect(after[0].news2_count).toBe(1);
    expect(after[0].alert_count).toBeGreaterThan(0);
    expect(after[0].verification_events).toBe(1);

    const replay = await verifyDeviceVitals(vitalsId, {
      actorUid: VERIFYING_CLINICIAN,
      actorRole: 'NURSING_STAFF',
      tenantId: TENANT,
    });
    expect(replay.verification_replayed).toBe(true);
    const afterReplay = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=$1::int) AS news2_count,
         (SELECT COUNT(*)::int FROM clinical_alerts WHERE source_vitals_chart_id=$1::int) AS alert_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$2::uuid AND source_table='vitals_chart'
             AND source_id=$1::text AND event_type='vitals.fhir_verified') AS verification_events`,
      vitalsId,
      TENANT,
    );
    expect(afterReplay).toEqual(after);
  });

  it('keeps verification evidence durable and resumes effects exactly once after a transient activation failure', async () => {
    const observedAt = new Date(Date.now() - 90_000).toISOString();
    const imported = await importFhirBundle(
      heartRateBundle(observedAt, 180, { id: `verify-recovery-${crypto.randomUUID()}` }),
      IMPORTER,
      { tenantId: TENANT, autoVerifyClinicalVitals: false },
    );
    const vitalsId = Number(imported.observationPartitions[0].vitalsChartId);

    await exec(`
      CREATE OR REPLACE FUNCTION test_fhir_verification_news2_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.patient_uid = '00000000-0000-4000-8000-0000000f4151'::uuid THEN
          RAISE EXCEPTION 'forced FHIR verification NEWS2 failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await exec(`
      CREATE TRIGGER test_fhir_verification_news2_failure
      BEFORE INSERT ON news2_scores
      FOR EACH ROW EXECUTE FUNCTION test_fhir_verification_news2_failure()
    `);
    try {
      await expect(verifyDeviceVitals(vitalsId, {
        actorUid: VERIFYING_CLINICIAN,
        actorRole: 'NURSING_STAFF',
        tenantId: TENANT,
      })).rejects.toThrow(/forced FHIR verification NEWS2 failure/);
    } finally {
      await exec(`DROP TRIGGER IF EXISTS test_fhir_verification_news2_failure ON news2_scores`);
      await exec(`DROP FUNCTION IF EXISTS test_fhir_verification_news2_failure()`);
    }

    const afterFailure = await query(
      `SELECT vitals.device_verified,
              (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=vitals.id) AS news2_count,
              (SELECT COUNT(*)::int FROM clinical_timeline_events
                WHERE tenant_id=vitals.tenant_id AND source_table='vitals_chart'
                  AND source_id=vitals.id::text AND event_type='vitals.fhir_verified') AS verification_events
         FROM vitals_chart AS vitals
        WHERE vitals.tenant_id=$1::uuid AND vitals.id=$2::int`,
      TENANT,
      vitalsId,
    );
    expect(afterFailure).toEqual([{
      device_verified: true,
      news2_count: 0,
      verification_events: 1,
    }]);

    const recovered = await verifyDeviceVitals(vitalsId, {
      actorUid: VERIFYING_CLINICIAN,
      actorRole: 'NURSING_STAFF',
      tenantId: TENANT,
    });
    expect(recovered).toMatchObject({
      verification_replayed: true,
      clinical_effects: { pendingEffects: [] },
    });
    const afterRecovery = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id=$1::int) AS news2_count,
         (SELECT COUNT(*)::int FROM clinical_alerts WHERE source_vitals_chart_id=$1::int) AS alert_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$2::uuid AND source_table='vitals_chart'
             AND source_id=$1::text AND event_type='vitals.fhir_verified') AS verification_events`,
      vitalsId,
      TENANT,
    );
    expect(afterRecovery[0]).toMatchObject({ news2_count: 1, verification_events: 1 });
    expect(afterRecovery[0].alert_count).toBeGreaterThan(0);
  });

  it('a near-duplicate import inserts a distinct fhir-sourced row; the staff row is untouched; timeline + audit exist; re-import dedupes', async () => {
    // A nurse charted HR 80 at time T.
    const chartedAt = new Date(Date.now() - 5 * 60 * 1000);
    await exec(
      `INSERT INTO vitals_chart (tenant_id, patient_uid, heart_rate, source, recorded_by, recorded_at)
       VALUES ($1::uuid, $2::uuid, 80, 'staff', $3::uuid, $4::timestamptz)`,
      TENANT, PATIENT, IMPORTER, chartedAt,
    );

    // An external FHIR bundle carries HR 90 for (nearly) the same instant —
    // inside the old ±1-minute overwrite window.
    const observedAt = new Date(chartedAt.getTime() + 20 * 1000).toISOString();
    const results = await importFhirBundle(heartRateBundle(observedAt, 90), IMPORTER, { tenantId: TENANT });
    expect(results.errors).toEqual([]);
    expect(results.imported).toBe(1);

    const rows = await query(
      `SELECT id, heart_rate, source, recorded_by
         FROM vitals_chart WHERE patient_uid = $1::uuid ORDER BY id`,
      PATIENT,
    );
    expect(rows).toHaveLength(2);
    // The staff-charted row is untouched.
    expect(Number(rows[0].heart_rate)).toBe(80);
    expect(rows[0].source).toBe('staff');
    // The import landed as its OWN row, labelled with its provenance.
    expect(Number(rows[1].heart_rate)).toBe(90);
    expect(rows[1].source).toBe('fhir');
    const importedRowId = rows[1].id;

    // Canonical clinical timeline invariant: the imported vital carries its
    // own timeline + audit pair.
    const timeline = await query(
      `SELECT id FROM clinical_timeline_events
        WHERE source_table = 'vitals_chart' AND source_id = $1::text
          AND event_type = 'vitals.recorded'`,
      String(importedRowId),
    );
    expect(timeline).toHaveLength(1);
    const audit = await query(
      `SELECT id FROM clinical_audit_events
        WHERE resource_table = 'vitals_chart' AND resource_id = $1::text`,
      String(importedRowId),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Re-importing the same bundle is an idempotent skip — no third row, and
    // still no mutation of the charted row.
    const rerun = await importFhirBundle(heartRateBundle(observedAt, 90), IMPORTER, { tenantId: TENANT });
    expect(rerun.errors).toEqual([]);
    expect(rerun.imported).toBe(0);
    expect(rerun.deduplicated).toBe(1);
    const after = await query(
      `SELECT id, heart_rate, source FROM vitals_chart WHERE patient_uid = $1::uuid ORDER BY id`,
      PATIENT,
    );
    expect(after).toHaveLength(2);
    expect(Number(after[0].heart_rate)).toBe(80);
  });

  it('an old observation timestamp is accepted (fhir ingest is backdate-exempt)', async () => {
    const observedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const results = await importFhirBundle(heartRateBundle(observedAt, 76), IMPORTER, { tenantId: TENANT });
    expect(results.errors).toEqual([]);
    expect(results.imported).toBe(1);

    const rows = await query(
      `SELECT source FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('fhir');
  });

  it('keeps distinct FHIR readings inside one minute while deduping an exact replay', async () => {
    const firstAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const secondAt = new Date(firstAt.getTime() + 20 * 1000);

    const first = await importFhirBundle(
      heartRateBundle(firstAt.toISOString(), 84),
      IMPORTER,
      { tenantId: TENANT },
    );
    const secondBundle = heartRateBundle(secondAt.toISOString(), 85);
    const second = await importFhirBundle(secondBundle, IMPORTER, { tenantId: TENANT });
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);

    const rows = await query(
      `SELECT heart_rate, source_device
         FROM vitals_chart
        WHERE patient_uid = $1::uuid
          AND recorded_at IN ($2::timestamptz, $3::timestamptz)
        ORDER BY recorded_at`,
      PATIENT,
      firstAt,
      secondAt,
    );
    expect(rows.map((row) => Number(row.heart_rate))).toEqual([84, 85]);
    expect(rows.every((row) => String(row.source_device).startsWith('fhir-set:'))).toBe(true);

    await importFhirBundle(secondBundle, IMPORTER, { tenantId: TENANT });
    const replayRows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      secondAt,
    );
    expect(replayRows).toHaveLength(1);
  });

  it('deduplicates timezone-equivalent representations of the same FHIR resource', async () => {
    const utcInstant = '2026-08-09T10:00:00.123Z';
    const offsetInstant = '2026-08-09T15:30:00.123+05:30';

    const first = await importFhirBundle(heartRateBundle(utcInstant, 82), IMPORTER, { tenantId: TENANT });
    const replay = await importFhirBundle(heartRateBundle(offsetInstant, 82), IMPORTER, { tenantId: TENANT });

    expect(first).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));
    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(utcInstant),
    );
    expect(rows).toHaveLength(1);
  });

  it('deduplicates unit-equivalent values but preserves a distinct FHIR resource id', async () => {
    const observedAt = '2026-08-09T11:00:00.456Z';
    const metres = await importFhirBundle(
      heightBundle(observedAt, 1.82, { code: 'm', unit: 'metres' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    const centimetreReplay = await importFhirBundle(
      heightBundle(observedAt, 182, { code: 'cm', unit: 'centimetres' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    const distinctId = await importFhirBundle(
      heightBundle(observedAt, 182, {
        id: 'obs-height-distinct',
        code: 'cm',
        unit: 'centimetres',
      }),
      IMPORTER,
      { tenantId: TENANT },
    );

    expect(metres).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    expect(centimetreReplay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));
    expect(distinctId).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    const rows = await query(
      `SELECT height_cm, source_device FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz
        ORDER BY id`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(({ height_cm: heightCm }) => Number(heightCm))).toEqual([182, 182]);
    expect(new Set(rows.map(({ source_device: sourceDevice }) => sourceDevice)).size).toBe(2);
  });

  it('atomically conflicts concurrent changed content under one logical Observation.id', async () => {
    const observedAt = '2026-08-09T11:30:00.456Z';
    const logicalResourceId = 'obs-hr-shared-logical';
    const sourceA = heartRateBundle(observedAt, 80, { id: logicalResourceId });
    sourceA.entry[0].fullUrl = `https://source-a.example/fhir/Observation/${logicalResourceId}`;
    sourceA.entry[0].resource.meta = { versionId: '1' };
    const changedContent = heartRateBundle(observedAt, 81, { id: logicalResourceId });
    changedContent.entry[0].fullUrl = `https://source-b.example/fhir/Observation/${logicalResourceId}`;
    changedContent.entry[0].resource.meta = { versionId: '2' };

    const concurrent = await Promise.all([
      importFhirBundle(sourceA, IMPORTER, { tenantId: TENANT }),
      importFhirBundle(changedContent, IMPORTER, { tenantId: TENANT }),
    ]);
    const winnerIndex = concurrent.findIndex(({ imported }) => imported === 1);
    const loserIndex = concurrent.findIndex(({ errors }) => errors.length === 1);

    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect(winnerIndex).not.toBe(loserIndex);
    expect(concurrent.reduce((sum, result) => sum + result.imported, 0)).toBe(1);
    expect(concurrent.reduce((sum, result) => sum + result.deduplicated, 0)).toBe(0);
    expect(concurrent.reduce((sum, result) => sum + result.errors.length, 0)).toBe(1);
    expect(concurrent[loserIndex]).toEqual(expect.objectContaining({
      imported: 0,
      skipped: 0,
      deduplicated: 0,
      errors: [expect.objectContaining({
        id: logicalResourceId,
        code: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
        error: expect.stringMatching(/already imported with different canonical content/),
      })],
      observationPartitions: [expect.objectContaining({
        status: 'error',
        resourceCount: 1,
        errorCode: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
      })],
    }));

    const committed = await query(
      `SELECT v.id, v.heart_rate, v.source_device,
              COUNT(n.id)::integer AS news2_count,
              n.supplemental_o2, n.partial_score, n.missing_params
         FROM vitals_chart v
         LEFT JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz
        GROUP BY v.id, v.heart_rate, v.source_device,
                 n.supplemental_o2, n.partial_score, n.missing_params`,
      PATIENT, new Date(observedAt),
    );
    expect(committed).toHaveLength(1);
    expect(Number(committed[0].heart_rate)).toBe(winnerIndex === 0 ? 80 : 81);
    expect(committed[0]).toEqual(expect.objectContaining({
      news2_count: 1,
      supplemental_o2: null,
      partial_score: true,
      missing_params: expect.arrayContaining(['supplemental_o2']),
    }));

    const receipts = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND resource_id = $4) AS receipts,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_sets
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND observed_at = $3::timestamptz) AS sets,
         (SELECT COUNT(*)::integer
            FROM fhir_vital_observation_set_resources links
            JOIN fhir_vital_observation_sets sets
              ON sets.tenant_id = links.tenant_id
             AND sets.set_fingerprint = links.set_fingerprint
           WHERE sets.tenant_id = $1::uuid
             AND sets.patient_uid = $2::uuid
             AND sets.observed_at = $3::timestamptz) AS links`,
      TENANT, PATIENT, new Date(observedAt), logicalResourceId,
    );
    expect(receipts[0]).toEqual({ receipts: 1, sets: 1, links: 1 });

    const winningReplay = structuredClone(winnerIndex === 0 ? sourceA : changedContent);
    winningReplay.entry[0].fullUrl = `https://untrusted-replay.example/fhir/Observation/${logicalResourceId}`;
    winningReplay.entry[0].resource.meta.versionId = '999';
    const replay = await importFhirBundle(winningReplay, IMPORTER, { tenantId: TENANT });
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));

    const distinctId = structuredClone(winningReplay);
    distinctId.entry[0].resource.id = 'obs-hr-distinct';
    const distinct = await importFhirBundle(distinctId, IMPORTER, { tenantId: TENANT });
    expect(distinct).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    const finalRows = await query(
      `SELECT COUNT(*)::integer AS vitals_count,
              COUNT(n.id)::integer AS news2_count
         FROM vitals_chart v
         LEFT JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(finalRows[0]).toEqual({ vitals_count: 2, news2_count: 2 });
  });

  it('rejects an empty FHIR vital instead of coercing it to a critical zero', async () => {
    const bundle = heartRateBundle(new Date().toISOString(), 72);
    delete bundle.entry[0].resource.valueQuantity;
    bundle.entry[0].resource.valueString = '   ';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors).toHaveLength(result.failed);
    expect(result.errors[0].error).toMatch(/finite numeric Quantity value/);
    expect(result.resource_receipts).toEqual([expect.objectContaining({
      id: expect.any(String),
      source_resource_type: 'Observation',
      source_resource_id: bundle.entry[0].resource.id,
      outcome: 'failed',
      target_table: null,
      target_id: null,
    })]);
    expect(result.reconciliation_items).toEqual([expect.objectContaining({
      resource_receipt_id: result.resource_receipts[0].id,
      opened_event_id: expect.any(String),
      status: 'OPENED',
    })]);

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND heart_rate = 0`,
      PATIENT,
    );
    expect(rows).toHaveLength(0);
  });

  it('keeps supplemental oxygen unknown while persisting a lower-bound partial NEWS2', async () => {
    const observedAt = new Date(Date.now() - 49 * 60 * 1000).toISOString();
    const resourceId = `obs-no-oxygen-evidence-${Date.now()}`;
    const result = await importFhirBundle(
      heartRateBundle(observedAt, 72, { id: resourceId }),
      IMPORTER,
      { tenantId: TENANT },
    );

    expect(result).toEqual(expect.objectContaining({ imported: 1, errors: [] }));
    const rows = await query(
      `SELECT vitals.supplemental_o2,
              score.supplemental_o2 AS score_supplemental_o2,
              score.total_score,
              score.partial_score,
              score.missing_params
         FROM vitals_chart AS vitals
         JOIN news2_scores AS score ON score.vitals_chart_id = vitals.id
        WHERE vitals.patient_uid = $1::uuid
          AND vitals.recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows).toEqual([expect.objectContaining({
      supplemental_o2: null,
      score_supplemental_o2: null,
      total_score: 0,
      partial_score: true,
      missing_params: expect.arrayContaining(['supplemental_o2']),
    })]);
  });

  it('deduplicates a direct Observation retry onto the same durable row and completed effects', async () => {
    const observedAt = new Date(Date.now() - 48 * 60 * 1000).toISOString();
    const resource = heartRateBundle(observedAt, 132, {
      id: `obs-direct-route-retry-${Date.now()}`,
    }).entry[0].resource;

    const first = await importFhirVitalObservation(resource, IMPORTER, { tenantId: TENANT });
    const retry = await importFhirVitalObservation(structuredClone(resource), IMPORTER, { tenantId: TENANT });

    expect(first).toEqual(expect.objectContaining({
      status: 'imported',
      deduplicated: false,
      patientUid: PATIENT,
    }));
    expect(retry).toEqual(expect.objectContaining({
      status: 'deduplicated',
      deduplicated: true,
      vitalsChartId: first.vitalsChartId,
      setFingerprint: first.setFingerprint,
    }));

    const effectRows = await query(
      `SELECT score.id AS news2_id, task.workflow_sla_instance_id
         FROM news2_scores AS score
         LEFT JOIN tasks AS task
           ON task.tenant_id = score.tenant_id
          AND task.related_resource_type = 'news2_score'
          AND task.related_resource_id = score.id::text
        WHERE score.vitals_chart_id = $1::integer
          AND score.superseded_at IS NULL`,
      first.vitalsChartId,
    );
    expect(effectRows).toHaveLength(1);
    expect(effectRows[0].workflow_sla_instance_id).toEqual(expect.any(String));

    // Recreate a post-commit failure window on the direct-Observation contract:
    // the clinical row and receipts remain durable, but the downstream effects
    // and their completion evidence are gone. The next HTTP-equivalent retry
    // must restore the effects without creating another clinical row.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = 'news2_score'
            AND related_resource_id = $2::text`,
        TENANT,
        String(effectRows[0].news2_id),
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances WHERE id = $1::uuid`,
        effectRows[0].workflow_sla_instance_id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_alerts
          WHERE tenant_id = $1::uuid
            AND patient_id = (SELECT id FROM users WHERE uid = $2::uuid)`,
        TENANT,
        PATIENT,
      );
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = NULL,
                anomaly_effects_completed_at = NULL
          WHERE tenant_id = $1::uuid
            AND vitals_chart_id = $2::integer`,
        TENANT,
        first.vitalsChartId,
      );
    });

    const recoveryRetry = await importFhirVitalObservation(
      structuredClone(resource),
      IMPORTER,
      { tenantId: TENANT },
    );
    expect(recoveryRetry).toEqual(expect.objectContaining({
      status: 'deduplicated',
      deduplicated: true,
      vitalsChartId: first.vitalsChartId,
      setFingerprint: first.setFingerprint,
      clinicalEffectsReconciled: true,
    }));
    const rows = await query(
      `SELECT COUNT(*)::integer AS vitals_count,
              COUNT(score.id)::integer AS news2_count,
              BOOL_AND(sets.news2_effects_completed_at IS NOT NULL) AS news2_complete,
              BOOL_AND(sets.anomaly_effects_completed_at IS NOT NULL) AS anomaly_complete
         FROM vitals_chart AS vitals
         JOIN news2_scores AS score ON score.vitals_chart_id = vitals.id
         JOIN fhir_vital_observation_sets AS sets ON sets.vitals_chart_id = vitals.id
        WHERE vitals.patient_uid = $1::uuid
          AND vitals.recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows).toEqual([{
      vitals_count: 1,
      news2_count: 1,
      news2_complete: true,
      anomaly_complete: true,
    }]);

    const recoveredEffects = await query(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = 'news2_score'
             AND related_resource_id = $2::text) AS task_count,
         (SELECT COUNT(*)::integer
            FROM clinical_alerts
           WHERE tenant_id = $1::uuid
             AND patient_id = (SELECT id FROM users WHERE uid = $3::uuid)) AS alert_count`,
      TENANT,
      String(effectRows[0].news2_id),
      PATIENT,
    );
    expect(recoveredEffects[0].task_count).toBe(1);
  });

  it('returns a sanitized retryable service error when direct ingestion fails internally', async () => {
    const observedAt = new Date(Date.now() - 47 * 60 * 1000).toISOString();
    const resourceId = `obs-direct-internal-failure-${Date.now()}`;
    const resource = heartRateBundle(observedAt, 74, { id: resourceId }).entry[0].resource;
    const internalMarker = 'database-host-and-query-must-not-leak';

    let caught;
    try {
      await importFhirVitalObservation(resource, IMPORTER, {
        tenantId: TENANT,
        beforeFhirVitalWrite: async () => {
          throw new Error(internalMarker);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(expect.objectContaining({
      statusCode: 503,
      code: 'FHIR_OBSERVATION_RECOVERY_UNAVAILABLE',
    }));
    expect(caught.message).not.toContain(internalMarker);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE tenant_id = $3::uuid AND resource_id = $4) AS receipts`,
      PATIENT,
      new Date(observedAt),
      TENANT,
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('returns retryable 409 while another direct replay owns the effect lease', async () => {
    const observedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
    const resource = heartRateBundle(observedAt, 132, {
      id: `obs-direct-effect-busy-${Date.now()}`,
    }).entry[0].resource;
    const first = await importFhirVitalObservation(resource, IMPORTER, { tenantId: TENANT });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = NULL,
                anomaly_effects_completed_at = NULL,
                news2_effects_claimed_at = clock_timestamp(),
                news2_effects_claim_token = '00000000-0000-4000-8000-0000000f4191'::uuid,
                anomaly_effects_claimed_at = clock_timestamp(),
                anomaly_effects_claim_token = '00000000-0000-4000-8000-0000000f4192'::uuid
          WHERE tenant_id = $1::uuid AND vitals_chart_id = $2::integer`,
        TENANT,
        first.vitalsChartId,
      );
    });

    let caught;
    try {
      await importFhirVitalObservation(structuredClone(resource), IMPORTER, { tenantId: TENANT });
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({
      statusCode: 409,
      code: 'FHIR_OBSERVATION_EFFECTS_IN_PROGRESS',
    }));

    await exec(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_claimed_at = NULL,
              news2_effects_claim_token = NULL,
              anomaly_effects_claimed_at = NULL,
              anomaly_effects_claim_token = NULL
        WHERE tenant_id = $1::uuid AND vitals_chart_id = $2::integer`,
      TENANT,
      first.vitalsChartId,
    );
    const recovered = await importFhirVitalObservation(
      structuredClone(resource),
      IMPORTER,
      { tenantId: TENANT },
    );
    expect(recovered).toEqual(expect.objectContaining({
      status: 'deduplicated',
      vitalsChartId: first.vitalsChartId,
      clinicalEffectsReconciled: true,
    }));
  });

  it.each([
    ['missing', null],
    ['registered', 'registered'],
    ['preliminary', 'preliminary'],
    ['cancelled', 'cancelled'],
    ['entered-in-error', 'entered-in-error'],
    ['unknown', 'unknown'],
  ])('rejects %s Observation status before any clinical or receipt write', async (_label, status) => {
    const statusOffset = ['missing', 'registered', 'preliminary', 'cancelled', 'entered-in-error', 'unknown']
      .indexOf(_label);
    const observedAt = new Date(Date.now() - (50 + statusOffset) * 60 * 1000).toISOString();
    const bundle = heartRateBundle(observedAt, 72, {
      id: `obs-status-${_label}-${Date.now()}`,
      status,
    });
    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FHIR_OBSERVATION_STATUS_NOT_CHARTABLE',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts,
         (SELECT COUNT(*)::integer FROM news2_scores
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS news2`,
      PATIENT, new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0, news2: 0 });
  });

  it('rejects issued-only data instead of treating release time as physiologic observation time', async () => {
    const issuedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const bundle = heartRateBundle(issuedAt, 72, { id: `obs-issued-only-${Date.now()}` });
    delete bundle.entry[0].resource.effectiveDateTime;
    bundle.entry[0].resource.issued = issuedAt;

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FHIR_OBSERVATION_TIMESTAMP_REQUIRED',
    })]);
    expect(result.imported).toBe(0);
  });

  it.each([
    ['slash-formatted', '08/09/2026 10:30'],
    ['timezone-less', '2026-08-09T10:30:00'],
    ['non-leap February 29', '2025-02-29T10:30:00Z'],
    ['February 30', '2026-02-30T10:30:00Z'],
    ['February 31', '2026-02-31T10:30:00Z'],
    ['April 31', '2026-04-31T10:30:00Z'],
    ['sub-millisecond precision', '2026-08-09T10:30:00.1234Z'],
  ])('rejects a %s effectiveDateTime before any clinical or receipt write', async (_label, observedAt) => {
    const resourceId = `obs-invalid-time-${_label}-${Date.now()}`;
    const beforeRows = await query(
      `SELECT COUNT(*)::integer AS count FROM vitals_chart WHERE patient_uid = $1::uuid`,
      PATIENT,
    );
    const result = await importFhirBundle(
      heartRateBundle(observedAt, 72, { id: resourceId }),
      IMPORTER,
      { tenantId: TENANT },
    );

    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FHIR_OBSERVATION_TIMESTAMP_INVALID',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $2) AS receipts`,
      PATIENT,
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: beforeRows[0].count, receipts: 0 });
  });

  it('canonicalizes equivalent Z and explicit-offset effectiveDateTime values for replay', async () => {
    const observedAt = new Date(Date.now() - 30.5 * 60 * 1000);
    observedAt.setMilliseconds(0);
    const utcTimestamp = observedAt.toISOString();
    const offsetTimestamp = new Date(observedAt.getTime() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .replace('Z', '+05:30');
    const resourceId = `obs-offset-replay-${Date.now()}`;

    const first = await importFhirBundle(
      heartRateBundle(utcTimestamp, 72, { id: resourceId }),
      IMPORTER,
      { tenantId: TENANT },
    );
    const replay = await importFhirBundle(
      heartRateBundle(offsetTimestamp, 72, { id: resourceId }),
      IMPORTER,
      { tenantId: TENANT },
    );

    expect(first).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      observedAt,
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 1, receipts: 1 });
  });

  it('rejects a supported code carried by a lookalike LOINC system', async () => {
    const observedAt = new Date(Date.now() - 30.75 * 60 * 1000).toISOString();
    const resourceId = `obs-lookalike-loinc-${Date.now()}`;
    const bundle = heartRateBundle(observedAt, 72, { id: resourceId });
    bundle.entry[0].resource.code.coding[0].system = 'https://example.invalid/not-loinc-but-says-loinc';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({
      imported: 0,
      skipped: 1,
      deduplicated: 0,
      errors: [],
    }));
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects a recognized unit code carried by a non-UCUM system', async () => {
    const observedAt = new Date(Date.now() - 30.875 * 60 * 1000).toISOString();
    const resourceId = `obs-lookalike-ucum-${Date.now()}`;
    const bundle = heartRateBundle(observedAt, 72, { id: resourceId });
    bundle.entry[0].resource.valueQuantity = {
      value: 72,
      system: 'https://example.invalid/not-ucum',
      code: '/min',
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FHIR_OBSERVATION_INVALID_UNIT',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects a wrong-case code under the canonical case-sensitive UCUM system', async () => {
    const observedAt = new Date(Date.now() - 30.9 * 60 * 1000).toISOString();
    const resourceId = `obs-wrong-case-ucum-${Date.now()}`;
    const bundle = heartRateBundle(observedAt, 1, { id: resourceId });
    bundle.entry[0].resource.code.coding[0].code = '2339-0';
    bundle.entry[0].resource.valueQuantity = {
      value: 1,
      system: 'http://unitsofmeasure.org',
      code: 'Mg/dL',
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FHIR_OBSERVATION_INVALID_UNIT',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('does not accept vital-signs from a lookalike observation-category system', async () => {
    const observedAt = new Date(Date.now() - 30.9375 * 60 * 1000).toISOString();
    const resourceId = `obs-lookalike-vital-category-${Date.now()}`;
    const bundle = heartRateBundle(observedAt, 72, { id: resourceId });
    bundle.entry[0].resource.category[0].coding[0].system = 'https://example.invalid/observation-category';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({
      imported: 0,
      skipped: 1,
      deduplicated: 0,
      errors: [],
    }));
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it.each([
    ['LOINC code', 'loinc', 0, (bundle) => { delete bundle.entry[0].resource.code.coding[0].system; }],
    ['vital-signs category', 'category', 1, (bundle) => { delete bundle.entry[0].resource.category[0].coding[0].system; }],
  ])('does not accept systemless %s authority', async (_label, suffix, offset, mutate) => {
    const observedAt = new Date(Date.now() - (31.25 + offset / 16) * 60 * 1000).toISOString();
    const resourceId = `obs-systemless-${suffix}-${Date.now()}`;
    const bundle = heartRateBundle(observedAt, 72, { id: resourceId });
    mutate(bundle);

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({
      imported: 0,
      skipped: 1,
      deduplicated: 0,
      errors: [],
    }));
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it.each(['<', '<=', '>=', '>'])('rejects the %s Quantity comparator before any write', async (comparator) => {
    const offset = ['<', '<=', '>=', '>'].indexOf(comparator);
    const observedAt = new Date(Date.now() - (31 + offset / 16) * 60 * 1000).toISOString();
    const resourceId = `obs-comparator-${offset}-${Date.now()}`;
    const bundle = heartRateBundle(observedAt, 40, { id: resourceId });
    bundle.entry[0].resource.valueQuantity.comparator = comparator;

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FHIR_OBSERVATION_INVALID_VALUE',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects an invalid-status composite authority before charting any final member', async () => {
    const observedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-invalid-parent' });
    bundle.entry[0].resource.status = 'entered-in-error';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toHaveLength(6);
    expect(result.errors.every(({ code }) => code === 'FHIR_OBSERVATION_STATUS_NOT_CHARTABLE')).toBe(true);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects a hasMember authority missing the vital-signs category instead of splitting its children', async () => {
    const observedAt = new Date(Date.now() - 31.5 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-missing-parent-category' });
    delete bundle.entry[0].resource.category;

    await expect(importFhirBundle(bundle, IMPORTER, { tenantId: TENANT })).rejects.toMatchObject({
      code: 'FHIR_OBSERVATION_COMPOSITE_PARENT_INVALID',
    });
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('skips a valid non-vital hasMember panel without aborting an importable vital in the Bundle', async () => {
    const observedAt = new Date(Date.now() - 31.75 * 60 * 1000).toISOString();
    const heartRate = heartRateBundle(observedAt, 76, { id: `obs-hr-with-lab-panel-${Date.now()}` });
    const labChildId = `obs-lab-child-${Date.now()}`;
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: `obs-lab-panel-${Date.now()}`,
          status: 'final',
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '24323-8' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: observedAt,
          hasMember: [{ reference: `Observation/${labChildId}` }],
        },
      }, {
        resource: {
          resourceType: 'Observation',
          id: labChildId,
          status: 'final',
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '718-7' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: observedAt,
          valueQuantity: { value: 12.1, code: 'g/dL' },
        },
      }, ...heartRate.entry],
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result).toEqual(expect.objectContaining({ imported: 1, skipped: 2, errors: [] }));
    const rows = await query(
      `SELECT heart_rate FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows.map(({ heart_rate: heartRateValue }) => Number(heartRateValue))).toEqual([76]);
  });

  it('rejects a composite with an unsupported-only declared vital member without narrowing it', async () => {
    const observedAt = new Date(Date.now() - 32 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-unknown-member' });
    const unknownId = `obs-unknown-member-${Date.now()}`;
    bundle.entry[0].resource.hasMember.push({ reference: `Observation/${unknownId}` });
    bundle.entry.push({
      resource: {
        resourceType: 'Observation',
        id: unknownId,
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '99999-9' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: observedAt,
        valueQuantity: { value: 42, code: '1' },
      },
    });

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toHaveLength(7);
    expect(result.errors.some(({ code }) => (
      code === 'FHIR_OBSERVATION_COMPOSITE_MEMBER_UNSUPPORTED'
    ))).toBe(true);
    const rows = await query(
      `SELECT COUNT(*)::integer AS count FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0].count).toBe(0);
  });

  it('rejects unsupported components declared directly on a composite authority', async () => {
    const observedAt = new Date(Date.now() - 32.5 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-unknown-parent-component' });
    bundle.entry[0].resource.component = [{
      code: { coding: [{ system: 'http://loinc.org', code: '99999-8' }] },
      valueQuantity: { value: 42, system: 'http://unitsofmeasure.org', code: '1' },
    }];

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toHaveLength(6);
    expect(result.errors.some(({ code }) => code === 'FHIR_OBSERVATION_PARTIAL_COMPONENT_MAPPING')).toBe(true);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects an unsupported authority component even when it repeats the panel LOINC', async () => {
    const observedAt = new Date(Date.now() - 32.75 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-repeated-parent-code' });
    bundle.entry[0].resource.component = [{
      code: { coding: [{ system: 'http://loinc.org', code: '85353-1' }] },
      valueQuantity: { value: 42, system: 'http://unitsofmeasure.org', code: '1' },
    }];

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors).toHaveLength(6);
    expect(result.errors.some(({ code }) => code === 'FHIR_OBSERVATION_PARTIAL_COMPONENT_MAPPING')).toBe(true);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it.each([
    ['unknown panel', '99999-9', false],
    ['ordinary vital used as a panel', '8867-4', true],
  ])('rejects an %s hasMember authority before any write', async (_label, rootCode, withValue) => {
    const observedAt = new Date(Date.now() - 32.875 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: `-${rootCode}` });
    const parent = bundle.entry[0].resource;
    parent.code.coding[0].code = rootCode;
    parent.component = [];
    if (withValue) parent.valueQuantity = { value: 72, code: '/min' };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(result.errors.some(({ code }) => code === 'FHIR_OBSERVATION_COMPOSITE_PARENT_INVALID')).toBe(true);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects duplicate composite authority identities instead of dropping one group', async () => {
    const observedAt = new Date(Date.now() - 32.9375 * 60 * 1000).toISOString();
    const first = compositeNews2Bundle(observedAt, { idSuffix: '-duplicate-a' });
    const second = compositeNews2Bundle(observedAt, { idSuffix: '-duplicate-b' });
    first.entry[0].resource.id = 'duplicate-composite-authority';
    second.entry[0].resource.id = 'duplicate-composite-authority';
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [...first.entry, ...second.entry],
    };

    await expect(importFhirBundle(bundle, IMPORTER, { tenantId: TENANT })).rejects.toMatchObject({
      code: 'FHIR_OBSERVATION_AMBIGUOUS_COMPOSITE',
    });
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND observed_at = $2::timestamptz) AS receipts`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('fails closed when a composite declares a member missing from the Bundle', async () => {
    const observedAt = new Date(Date.now() - 33 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-missing-member' });
    bundle.entry.pop();

    await expect(importFhirBundle(bundle, IMPORTER, { tenantId: TENANT })).rejects.toMatchObject({
      code: 'FHIR_OBSERVATION_COMPOSITE_REFERENCE_UNRESOLVED',
    });
    const rows = await query(
      `SELECT COUNT(*)::integer AS count FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0].count).toBe(0);
  });

  it('never resolves a server-A relative member reference to a server-B fullUrl', async () => {
    const observedAt = new Date(Date.now() - 34 * 60 * 1000).toISOString();
    const bundle = heartRateBundle(observedAt, 72, { id: 'server-shared-observation' });
    bundle.entry[0].fullUrl = 'https://server-b.example/fhir/Observation/server-shared-observation';
    bundle.entry.unshift({
      fullUrl: 'https://server-a.example/fhir/Observation/vitals-panel',
      resource: {
        resourceType: 'Observation',
        id: 'vitals-panel',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '85353-1' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: observedAt,
        hasMember: [{ reference: 'Observation/server-shared-observation' }],
      },
    });

    await expect(importFhirBundle(bundle, IMPORTER, { tenantId: TENANT })).rejects.toMatchObject({
      code: 'FHIR_OBSERVATION_COMPOSITE_REFERENCE_UNRESOLVED',
    });
    const rows = await query(
      `SELECT COUNT(*)::integer AS count FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows[0].count).toBe(0);
  });

  it('resolves an absolute hasMember reference by exact fullUrl when logical ids collide', async () => {
    const observedAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const serverA = heartRateBundle(observedAt, 70, { id: 'shared-fullurl-id' }).entry[0];
    const serverB = heartRateBundle(observedAt, 150, { id: 'shared-fullurl-id' }).entry[0];
    serverA.fullUrl = 'https://server-a.example/fhir/Observation/shared-fullurl-id';
    serverB.fullUrl = 'https://server-b.example/fhir/Observation/shared-fullurl-id';
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        fullUrl: 'https://server-a.example/fhir/Observation/vitals-panel-exact',
        resource: {
          resourceType: 'Observation',
          id: 'vitals-panel-exact',
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '85353-1' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: observedAt,
          hasMember: [{ reference: serverA.fullUrl }],
        },
      }, serverA, serverB],
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(2);
    expect(result.errors).toEqual([expect.objectContaining({
      id: 'shared-fullurl-id',
      code: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
    })]);
    const rows = await query(
      `SELECT heart_rate FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows.map(({ heart_rate: heartRate }) => Number(heartRate))).toEqual([70]);
  });

  it('groups otherwise-unowned supported same-time Observations into one clinical row', async () => {
    const observedAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const heartRate = heartRateBundle(observedAt, 78, { id: `obs-independent-hr-${Date.now()}` });
    const height = heightBundle(observedAt, 171, { id: `obs-independent-height-${Date.now()}` });
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [...heartRate.entry, ...height.entry],
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result).toEqual(expect.objectContaining({ imported: 2, errors: [] }));
    const rows = await query(
      `SELECT heart_rate, height_cm, source_device
         FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz
        ORDER BY id`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect(rows.map(({ heart_rate: heartRateValue, height_cm: heightValue }) => [
      heartRateValue == null ? null : Number(heartRateValue),
      heightValue == null ? null : Number(heightValue),
    ])).toEqual([[78, 171]]);
    expect(rows[0].source_device).toMatch(/^fhir-set:/);
  });

  it('keeps the Bundle patient-survivor snapshot stable while a merge waits to commit', async () => {
    await exec(
      `INSERT INTO users
         (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990333447', 'FHIR Merge Race Patient', 'PATIENT', true, 'active',
               $2::uuid, NOW())`,
      MERGE_RACE_PATIENT,
      TENANT,
    );
    const observedAt = new Date(Date.now() - 35.5 * 60 * 1000).toISOString();
    const heartRate = heartRateBundle(observedAt, 82, { id: `obs-premerge-hr-${Date.now()}` });
    const height = heightBundle(observedAt, 168, { id: `obs-premerge-height-${Date.now()}` });

    // One import manifest authorises exactly ONE patient. A Bundle that reaches
    // past its target — here at the merge counterparty — is refused before any
    // write, so the race below necessarily runs on a single-patient manifest.
    const crossPatientHeight = heightBundle(observedAt, 168, { id: `obs-premerge-cross-${Date.now()}` });
    crossPatientHeight.entry[0].resource.subject.reference = `Patient/${MERGE_RACE_PATIENT}`;
    await expect(importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [...heartRate.entry, ...crossPatientHeight.entry],
    }, IMPORTER, { tenantId: TENANT })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RESOURCE_PATIENT_MISMATCH',
    });

    let mergeAttempt = null;
    let mergeLockAcquired = false;
    let observedMergeBlocked = false;
    let signalMergeStarted;
    const mergeStarted = new Promise((resolve) => { signalMergeStarted = resolve; });
    let result;
    try {
      result = await importFhirBundle({
        resourceType: 'Bundle',
        type: 'collection',
        entry: [...heartRate.entry, ...height.entry],
      }, IMPORTER, {
        tenantId: TENANT,
        beforeFhirVitalWrite: async () => {
          if (!mergeAttempt) {
            mergeAttempt = setTenantTx(TENANT, async (tx) => {
              signalMergeStarted();
              // A real merge takes the WRITER side of the merge-stability lock
              // (patientMergeService), which is what an in-flight import — a
              // reader — must hold it off from.
              await lockTenantPatientMergeExecutionExclusive(tx, TENANT);
              mergeLockAcquired = true;
              await tx.$executeRawUnsafe(
                `UPDATE users
                    SET is_active = false,
                        status = 'merged',
                        merged_into_uid = $1::uuid,
                        updated_at = NOW()
                  WHERE tenant_id = $2::uuid AND uid = $3::uuid`,
                MERGE_RACE_PATIENT,
                TENANT,
                PATIENT,
              );
            }, { timeout: PATIENT_MERGE_STABILITY_TIMEOUT_MS });
          }
          await mergeStarted;
          await new Promise((resolve) => setTimeout(resolve, 5_100));
          observedMergeBlocked ||= !mergeLockAcquired;
        },
      });
      await mergeAttempt;
    } finally {
      await mergeAttempt?.catch(() => {});
      await exec(
        `UPDATE users
            SET is_active = true,
                status = 'active',
                merged_into_uid = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        TENANT,
        PATIENT,
      ).catch(() => {});
    }

    expect(observedMergeBlocked).toBe(true);
    expect(mergeLockAcquired).toBe(true);
    expect(result).toEqual(expect.objectContaining({ imported: 2, errors: [] }));
    const rows = await query(
      `SELECT patient_uid, heart_rate, height_cm
         FROM vitals_chart
        WHERE recorded_at = $1::timestamptz
          AND patient_uid IN ($2::uuid, $3::uuid)
        ORDER BY patient_uid`,
      new Date(observedAt),
      PATIENT,
      MERGE_RACE_PATIENT,
    );
    // Both same-time observations landed on the identity the import resolved
    // under the merge-stability lock, as ONE row. The merge that committed the
    // instant the import released the lock must not have dragged them across to
    // the survivor identity — that is the snapshot staying stable.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ patient_uid: PATIENT }));
    expect([Number(rows[0].heart_rate), Number(rows[0].height_cm)]).toEqual([82, 168]);
  });

  it('groups same-time aliases only after resolving them to one active merge survivor', async () => {
    await exec(
      `INSERT INTO users
         (uid, phone, name, role, is_active, status, tenant_id, merged_into_uid, updated_at)
       VALUES ($1::uuid, '8990333446', 'Merged FHIR Alias', 'PATIENT', false, 'merged',
               $2::uuid, $3::uuid, NOW())`,
      MERGED_PATIENT_ALIAS,
      TENANT,
      PATIENT,
    );
    const observedAt = new Date(Date.now() - 36 * 60 * 1000).toISOString();
    const heartRate = heartRateBundle(observedAt, 82, { id: `obs-alias-hr-${Date.now()}` });
    heartRate.entry[0].resource.subject.reference = `Patient/${MERGED_PATIENT_ALIAS}`;
    const height = heightBundle(observedAt, 169, { id: `obs-survivor-height-${Date.now()}` });

    // The retired alias and its survivor are two patient references: one
    // manifest cannot carry both, whatever they resolve to.
    await expect(importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [...heartRate.entry, ...height.entry],
    }, IMPORTER, { tenantId: TENANT })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RESOURCE_PATIENT_MISMATCH',
    });

    // A manifest that IS the retired alias still resolves to the one active
    // merge survivor before grouping: both same-time observations collapse into
    // a single row keyed by the survivor, and nothing is written under the alias.
    height.entry[0].resource.subject.reference = `Patient/${MERGED_PATIENT_ALIAS}`;
    const result = await importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [...heartRate.entry, ...height.entry],
    }, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 2, errors: [] }));
    const rows = await query(
      `SELECT patient_uid, heart_rate, height_cm
         FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ patient_uid: PATIENT }));
    expect([Number(rows[0].heart_rate), Number(rows[0].height_cm)]).toEqual([82, 169]);
    const aliasRows = await query(
      `SELECT id FROM vitals_chart WHERE patient_uid = $1::uuid`,
      MERGED_PATIENT_ALIAS,
    );
    expect(aliasRows).toHaveLength(0);
  });

  it('rejects duplicate canonical fields in an implicit same-time group atomically', async () => {
    const observedAt = new Date(Date.now() - 37 * 60 * 1000).toISOString();
    const first = heartRateBundle(observedAt, 80, { id: `obs-implicit-hr-a-${Date.now()}` });
    const second = heartRateBundle(observedAt, 92, { id: `obs-implicit-hr-b-${Date.now()}` });

    const result = await importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [...first.entry, ...second.entry],
    }, IMPORTER, { tenantId: TENANT });

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every(({ error }) => /same canonical vital field/i.test(error))).toBe(true);
    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects a mixed supported/unsupported component Observation without consuming it', async () => {
    const observedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const resourceId = `obs-mixed-panel-${Date.now()}`;
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: resourceId,
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: observedAt,
          component: [
            {
              code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
              valueQuantity: { value: 118, code: 'mm[Hg]' },
            },
            {
              code: { coding: [{ system: 'http://loinc.org', code: '99999-9' }] },
              valueQuantity: { value: 42, code: '1' },
            },
          ],
        },
      }],
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([expect.objectContaining({
      id: resourceId,
      code: 'FHIR_OBSERVATION_PARTIAL_COMPONENT_MAPPING',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT, new Date(observedAt), resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('rejects a mixed component Observation whose extra component has no LOINC identity', async () => {
    const observedAt = new Date(Date.now() - 41 * 60 * 1000).toISOString();
    const resourceId = `obs-mixed-non-loinc-${Date.now()}`;
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: resourceId,
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: observedAt,
          component: [
            {
              code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
              valueQuantity: { value: 118, code: 'mm[Hg]' },
            },
            {
              code: { coding: [{ system: 'http://snomed.info/sct', code: '75367002' }] },
              valueQuantity: { value: 42, code: '1' },
            },
          ],
        },
      }],
    };

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([expect.objectContaining({
      id: resourceId,
      code: 'FHIR_OBSERVATION_PARTIAL_COMPONENT_MAPPING',
    })]);
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM vitals_chart
           WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz) AS vitals,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE patient_uid = $1::uuid AND resource_id = $3) AS receipts`,
      PATIENT,
      new Date(observedAt),
      resourceId,
    );
    expect(rows[0]).toEqual({ vitals: 0, receipts: 0 });
  });

  it('imports the original ungrouped five-resource bundle as one lower-bound NEWS2 12 emergency assessment', async () => {
    const observedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const result = await importFhirBundle(ungroupedNews2Bundle(observedAt), IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(5);

    const rows = await query(
      `SELECT v.id, v.respiratory_rate, v.spo2, v.systolic_bp, v.heart_rate, v.temperature,
              v.supplemental_o2, v.o2_flow_rate,
              n.id AS news2_id, n.supplemental_o2 AS score_supplemental_o2,
              n.total_score, n.clinical_risk, n.escalation_action,
              n.partial_score, n.missing_params
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz
          AND n.superseded_at IS NULL
        ORDER BY n.id DESC`,
      PATIENT, new Date(observedAt),
    );

    expect(rows).toHaveLength(1);
    expect([
      rows[0].respiratory_rate,
      rows[0].spo2,
      rows[0].systolic_bp,
      rows[0].heart_rate,
      rows[0].temperature,
    ].map(Number)).toEqual([26, 88, 88, 132, 37]);
    expect(rows[0].supplemental_o2).toBeNull();
    expect(rows[0].score_supplemental_o2).toBeNull();
    expect(rows[0].o2_flow_rate).toBeNull();
    expect(Number(rows[0].total_score)).toBe(12);
    expect(rows[0].clinical_risk).toBe('high');
    expect(rows[0].escalation_action).toMatch(/Emergency response/i);
    expect(rows[0].partial_score).toBe(true);
    expect(rows[0].missing_params).toEqual(expect.arrayContaining([
      'consciousness',
      'supplemental_o2',
    ]));

    const completionBefore = await query(
      `SELECT news2_effects_completed_at, anomaly_effects_completed_at
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid AND vitals_chart_id = $2::integer`,
      TENANT, rows[0].id,
    );
    expect(completionBefore).toEqual([expect.objectContaining({
      news2_effects_completed_at: expect.any(Date),
      anomaly_effects_completed_at: expect.any(Date),
    })]);
    const taskBefore = await query(
      `SELECT id, workflow_sla_instance_id
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'news2_score'
          AND related_resource_id = $2::text`,
      TENANT, String(rows[0].news2_id),
    );
    expect(taskBefore).toHaveLength(1);
    const alertsBefore = await query(
      `SELECT COUNT(*)::integer AS count
         FROM clinical_alerts
        WHERE tenant_id = $1::uuid
          AND patient_id = (SELECT id FROM users WHERE uid = $2::uuid)`,
      TENANT, PATIENT,
    );
    expect(alertsBefore[0].count).toBeGreaterThan(0);

    // Model the two load-bearing post-commit writes having failed: the
    // clinical row + NEWS2 score + receipt remain durable, but no task/alerts
    // or completion evidence exists. Exact replay must repair, not suppress.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = 'news2_score'
            AND related_resource_id = $2::text`,
        TENANT, String(rows[0].news2_id),
      );
      if (taskBefore[0].workflow_sla_instance_id) {
        await tx.$executeRawUnsafe(
          `DELETE FROM workflow_sla_instances WHERE id = $1::uuid`,
          taskBefore[0].workflow_sla_instance_id,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_alerts
          WHERE tenant_id = $1::uuid
            AND patient_id = (SELECT id FROM users WHERE uid = $2::uuid)`,
        TENANT, PATIENT,
      );
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = NULL,
                anomaly_effects_completed_at = NULL
          WHERE tenant_id = $1::uuid AND vitals_chart_id = $2::integer`,
        TENANT, rows[0].id,
      );
    });

    const concurrentReplays = await Promise.all([
      importFhirBundle(ungroupedNews2Bundle(observedAt), IMPORTER, { tenantId: TENANT }),
      importFhirBundle(ungroupedNews2Bundle(observedAt), IMPORTER, { tenantId: TENANT }),
    ]);
    const reconciliationWinners = concurrentReplays.filter(({ observationPartitions }) => (
      observationPartitions.some(({ clinicalEffectsReconciled }) => clinicalEffectsReconciled)
    ));
    expect(reconciliationWinners).toHaveLength(1);
    expect(reconciliationWinners[0].errors).toEqual([]);
    expect(reconciliationWinners[0].imported).toBe(0);
    expect(reconciliationWinners[0].deduplicated).toBe(5);
    expect(reconciliationWinners[0].observationPartitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'deduplicated',
        resourceCount: 5,
        clinicalEffectsReconciled: true,
      }),
    ]));
    const losingReplay = concurrentReplays.find((result) => result !== reconciliationWinners[0]);
    if (losingReplay.errors.length > 0) {
      expect(losingReplay.errors).toHaveLength(5);
      expect(losingReplay.errors.every(({ code }) => (
        code === 'FHIR_OBSERVATION_EFFECTS_IN_PROGRESS'
      ))).toBe(true);
    } else {
      expect(losingReplay.deduplicated).toBe(5);
    }
    const afterReplay = await query(
      `SELECT v.id, v.source_device, n.id AS news2_id
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0].source_device).toMatch(/^fhir-set:[0-9a-f]{64}$/);
    const repairedEffects = await query(
      `SELECT
         sets.news2_effects_completed_at,
         sets.anomaly_effects_completed_at,
         (SELECT COUNT(*)::integer
            FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = 'news2_score'
             AND related_resource_id = $3::text) AS task_count,
         (SELECT COUNT(*)::integer
            FROM clinical_alerts
           WHERE tenant_id = $1::uuid
             AND patient_id = (SELECT id FROM users WHERE uid = $4::uuid)) AS alert_count
        FROM fhir_vital_observation_sets AS sets
       WHERE sets.tenant_id = $1::uuid AND sets.vitals_chart_id = $2::integer`,
      TENANT, rows[0].id, String(rows[0].news2_id), PATIENT,
    );
    expect(repairedEffects).toEqual([expect.objectContaining({
      news2_effects_completed_at: expect.any(Date),
      anomaly_effects_completed_at: expect.any(Date),
      task_count: 1,
      alert_count: alertsBefore[0].count,
    })]);

    const distinct = await importFhirBundle(
      ungroupedNews2Bundle(observedAt, { idSuffix: '-distinct' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    expect(distinct.errors).toEqual([]);
    expect(distinct.imported).toBe(5);
    const distinctRows = await query(
      `SELECT v.source_device, n.total_score, n.clinical_risk
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz
        ORDER BY v.id`,
      PATIENT, new Date(observedAt),
    );
    expect(distinctRows).toHaveLength(2);
    expect(new Set(distinctRows.map((row) => row.source_device)).size).toBe(2);
    expect(distinctRows.map((row) => Number(row.total_score))).toEqual([12, 12]);
    expect(distinctRows.map((row) => row.clinical_risk)).toEqual(['high', 'high']);
  });

  it('scores explicit FHIR supplemental-oxygen evidence with the NEWS2 +2 modifier', async () => {
    const observedAt = new Date(Date.now() - 2.5 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-on-oxygen' });
    bundle.entry[0].resource.component[0].valueQuantity.value = 2;

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });

    expect(result).toEqual(expect.objectContaining({ imported: 6, errors: [] }));
    const rows = await query(
      `SELECT vitals.supplemental_o2, vitals.o2_flow_rate,
              score.supplemental_o2 AS score_supplemental_o2,
              score.total_score,
              (SELECT COUNT(*)::integer
                 FROM tasks
                WHERE tenant_id = $1::uuid
                  AND related_resource_type = 'news2_score'
                  AND related_resource_id = score.id::text) AS task_count
         FROM vitals_chart AS vitals
         JOIN news2_scores AS score ON score.vitals_chart_id = vitals.id
        WHERE vitals.tenant_id = $1::uuid
          AND vitals.patient_uid = $2::uuid
          AND vitals.recorded_at = $3::timestamptz`,
      TENANT,
      PATIENT,
      new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      supplemental_o2: true,
      score_supplemental_o2: true,
      total_score: 14,
      task_count: 1,
    }));
    expect(Number(rows[0].o2_flow_rate)).toBe(2);
  });

  it('backs off a poison recovery row so a later healthy set progresses with limit one', async () => {
    const poisonAt = new Date(Date.now() - 12 * 60 * 1000).toISOString();
    const healthyAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const poisonImport = await importFhirBundle(
      compositeNews2Bundle(poisonAt, { idSuffix: '-poison-sweep' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    const healthyImport = await importFhirBundle(
      compositeNews2Bundle(healthyAt, { idSuffix: '-healthy-sweep' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    expect(poisonImport.errors).toEqual([]);
    expect(healthyImport.errors).toEqual([]);

    const sets = await query(
      `SELECT sets.set_fingerprint, sets.vitals_chart_id, sets.observed_at, score.id AS news2_id
         FROM fhir_vital_observation_sets AS sets
         JOIN news2_scores AS score ON score.vitals_chart_id = sets.vitals_chart_id
        WHERE sets.tenant_id = $1::uuid
          AND sets.observed_at = ANY($2::timestamptz[])
        ORDER BY sets.created_at, sets.set_fingerprint`,
      TENANT,
      [new Date(poisonAt), new Date(healthyAt)],
    );
    expect(sets).toHaveLength(2);
    const poison = sets.find(({ observed_at: observedAt }) => (
      new Date(observedAt).toISOString() === poisonAt
    ));
    const healthy = sets.find(({ observed_at: observedAt }) => (
      new Date(observedAt).toISOString() === healthyAt
    ));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = NULL,
                anomaly_effects_completed_at = NULL,
                news2_effects_claimed_at = NULL,
                news2_effects_claim_token = NULL,
                news2_effects_next_retry_at = NULL,
                anomaly_effects_claimed_at = NULL,
                anomaly_effects_claim_token = NULL,
                anomaly_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid
            AND set_fingerprint = ANY($2::varchar[])`,
        TENANT,
        sets.map(({ set_fingerprint: setFingerprint }) => setFingerprint),
      );
      await tx.$executeRawUnsafe(
        `UPDATE news2_scores SET total_score = total_score + 1 WHERE id = $1::integer`,
        poison.news2_id,
      );
    });

    await expect(reconcilePendingFhirVitalEffects({ tenantId: TENANT, limit: 1 }))
      .rejects.toMatchObject({ code: 'FHIR_VITAL_EFFECT_SWEEP_FAILED' });
    const afterPoison = await query(
      `SELECT news2_effects_next_retry_at,
              news2_effects_completed_at,
              anomaly_effects_completed_at
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid AND set_fingerprint = $2`,
      TENANT,
      poison.set_fingerprint,
    );
    expect(afterPoison).toEqual([expect.objectContaining({
      news2_effects_next_retry_at: expect.any(Date),
      news2_effects_completed_at: null,
      anomaly_effects_completed_at: null,
    })]);
    expect(afterPoison[0].news2_effects_next_retry_at.getTime()).toBeGreaterThan(Date.now());

    const healthySweep = await reconcilePendingFhirVitalEffects({ tenantId: TENANT, limit: 1 });
    expect(healthySweep).toEqual(expect.objectContaining({
      scanned: 1,
      claimedEffects: 2,
      completedSets: 1,
      failedSets: 0,
    }));
    const afterHealthy = await query(
      `SELECT news2_effects_completed_at, anomaly_effects_completed_at
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid AND set_fingerprint = $2`,
      TENANT,
      healthy.set_fingerprint,
    );
    expect(afterHealthy).toEqual([expect.objectContaining({
      news2_effects_completed_at: expect.any(Date),
      anomaly_effects_completed_at: expect.any(Date),
    })]);
  });

  it('does not steal a live effect lease and reclaims it only after the crash lease expires', async () => {
    const observedAt = new Date(Date.now() - 13 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-stale-lease' });
    const imported = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(imported.errors).toEqual([]);
    const sets = await query(
      `SELECT set_fingerprint, vitals_chart_id,
              news2_effects_attempts, anomaly_effects_attempts
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid AND observed_at = $2::timestamptz`,
      TENANT,
      new Date(observedAt),
    );
    expect(sets).toHaveLength(1);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET news2_effects_completed_at = NULL,
                anomaly_effects_completed_at = NULL,
                news2_effects_claimed_at = clock_timestamp(),
                news2_effects_claim_token = '00000000-0000-4000-8000-000000000201'::uuid,
                news2_effects_next_retry_at = NULL,
                anomaly_effects_claimed_at = clock_timestamp(),
                anomaly_effects_claim_token = '00000000-0000-4000-8000-000000000202'::uuid,
                anomaly_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid AND set_fingerprint = $2`,
        TENANT,
        sets[0].set_fingerprint,
      );
    });

    const liveLeaseSweep = await reconcilePendingFhirVitalEffects({ tenantId: TENANT, limit: 1 });
    expect(liveLeaseSweep).toEqual(expect.objectContaining({ scanned: 0, claimedEffects: 0 }));
    await exec(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_claimed_at = clock_timestamp() - INTERVAL '10 minutes',
              anomaly_effects_claimed_at = clock_timestamp() - INTERVAL '10 minutes'
        WHERE tenant_id = $1::uuid AND set_fingerprint = $2`,
      TENANT,
      sets[0].set_fingerprint,
    );
    const staleLeaseSweep = await reconcilePendingFhirVitalEffects({ tenantId: TENANT, limit: 1 });
    expect(staleLeaseSweep).toEqual(expect.objectContaining({
      scanned: 1,
      claimedEffects: 2,
      completedSets: 1,
    }));
    const completed = await query(
      `SELECT news2_effects_completed_at, anomaly_effects_completed_at,
              news2_effects_claim_token, anomaly_effects_claim_token,
              news2_effects_attempts, anomaly_effects_attempts
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid AND set_fingerprint = $2`,
      TENANT,
      sets[0].set_fingerprint,
    );
    expect(completed).toEqual([expect.objectContaining({
      news2_effects_completed_at: expect.any(Date),
      anomaly_effects_completed_at: expect.any(Date),
      news2_effects_claim_token: null,
      anomaly_effects_claim_token: null,
      news2_effects_attempts: Number(sets[0].news2_effects_attempts) + 1,
      anomaly_effects_attempts: Number(sets[0].anomaly_effects_attempts) + 1,
    })]);
  });

  it('keeps component observations and source units inside the grouped bundle path', async () => {
    const observedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const result = await importFhirBundle(componentAndFahrenheitBundle(observedAt), IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(3);

    const rows = await query(
      `SELECT systolic_bp, diastolic_bp, temperature
         FROM vitals_chart
        WHERE patient_uid = $1::uuid
          AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect([rows[0].systolic_bp, rows[0].diastolic_bp, rows[0].temperature].map(Number))
      .toEqual([118, 72, 37]);
  });

  it('canonicalizes coding, component, and bundle ordering for replay identity', async () => {
    const observedAt = '2026-08-09T12:00:00.789Z';
    const bundle = componentAndFahrenheitBundle(observedAt);
    for (const { resource } of bundle.entry) {
      resource.code.coding.push({ system: 'http://snomed.info/sct', code: '75367002' });
      for (const component of resource.component || []) {
        component.code.coding.push({ system: 'http://snomed.info/sct', code: '75367002' });
      }
    }
    const replayBundle = structuredClone(bundle);
    replayBundle.entry.reverse();
    for (const { resource } of replayBundle.entry) {
      resource.code.coding.reverse();
      resource.component?.reverse();
      for (const component of resource.component || []) component.code.coding.reverse();
    }

    const first = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    const replay = await importFhirBundle(replayBundle, IMPORTER, { tenantId: TENANT });

    expect(first).toEqual(expect.objectContaining({ imported: 3, deduplicated: 0, errors: [] }));
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 3, errors: [] }));
    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
  });

  it('deduplicates a panel replay whose member references change from relative to base-equivalent absolute', async () => {
    const observedAt = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-reference-canonical' });
    const baseUrl = 'https://reference-canonical.example/fhir';
    for (const entry of bundle.entry) {
      entry.fullUrl = `${baseUrl}/Observation/${entry.resource.id}`;
    }
    const replayBundle = structuredClone(bundle);
    replayBundle.entry[0].resource.hasMember = replayBundle.entry.slice(1).map(({ fullUrl }) => ({
      reference: fullUrl,
    }));

    const first = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    const replay = await importFhirBundle(replayBundle, IMPORTER, { tenantId: TENANT });
    expect(first).toEqual(expect.objectContaining({ imported: 6, errors: [] }));
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 6, errors: [] }));
  });

  it('atomically claims concurrent replays and rejects a mixed superset without duplicating the clinical row', async () => {
    const observedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-receipt' });

    const [left, right] = await Promise.all([
      importFhirBundle(bundle, IMPORTER, { tenantId: TENANT }),
      importFhirBundle(bundle, IMPORTER, { tenantId: TENANT }),
    ]);
    const initialResults = [left, right];
    expect(initialResults.filter(({ imported }) => imported === 6)).toHaveLength(1);
    const concurrentReplay = initialResults.find(({ imported }) => imported === 0);
    if (concurrentReplay.errors.length > 0) {
      expect(concurrentReplay.errors).toHaveLength(6);
      expect(concurrentReplay.errors.every(({ code }) => (
        code === 'FHIR_OBSERVATION_EFFECTS_IN_PROGRESS'
      ))).toBe(true);
    } else {
      expect(concurrentReplay.deduplicated).toBe(6);
    }

    const subset = structuredClone(bundle);
    subset.entry = subset.entry.slice(1, 3);
    const subsetResult = await importFhirBundle(subset, IMPORTER, { tenantId: TENANT });
    expect(subsetResult).toEqual(expect.objectContaining({ imported: 0, deduplicated: 2, errors: [] }));

    const superset = structuredClone(bundle);
    superset.entry.push({
      resource: {
        resourceType: 'Observation',
        id: 'obs-dbp-receipt',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: observedAt,
        valueQuantity: { value: 70, code: 'mm[Hg]' },
      },
    });
    superset.entry[0].resource.hasMember.push({ reference: 'Observation/obs-dbp-receipt' });
    const supersetResult = await importFhirBundle(superset, IMPORTER, { tenantId: TENANT });
    expect(supersetResult).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(supersetResult.errors).toHaveLength(7);
    expect(supersetResult.errors[0]).toEqual(expect.objectContaining({
      code: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
    }));
    expect(supersetResult.observationPartitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'error',
        resourceCount: 7,
      }),
    ]));

    const rows = await query(
      `SELECT v.id, v.diastolic_bp, n.total_score, n.clinical_risk
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid AND v.recorded_at = $2::timestamptz
        ORDER BY v.id`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_score)).toBe(12);
    expect(rows[0].clinical_risk).toBe('high');
    expect(rows[0].diastolic_bp).toBeNull();

    const receipts = await query(
      `SELECT COUNT(*)::integer AS count
         FROM fhir_vital_observation_receipts
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND observed_at = $3::timestamptz`,
      TENANT, PATIENT, new Date(observedAt),
    );
    const sets = await query(
      `SELECT COUNT(*)::integer AS count
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND observed_at = $3::timestamptz`,
      TENANT, PATIENT, new Date(observedAt),
    );
    const links = await query(
      `SELECT COUNT(*)::integer AS count
         FROM fhir_vital_observation_set_resources links
         JOIN fhir_vital_observation_sets sets
           ON sets.tenant_id = links.tenant_id
          AND sets.set_fingerprint = links.set_fingerprint
        WHERE sets.tenant_id = $1::uuid
          AND sets.patient_uid = $2::uuid
          AND sets.observed_at = $3::timestamptz`,
      TENANT, PATIENT, new Date(observedAt),
    );
    expect(receipts[0].count).toBe(6);
    expect(sets[0].count).toBe(1);
    expect(links[0].count).toBe(6);
  });

  it('rejects a malformed known same-time component before writing any part of the set', async () => {
    const observedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt);
    bundle.entry[1].resource.valueQuantity.value = '88junk';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(6);
    expect(result.errors.some(({ error }) => /finite numeric Quantity value/i.test(error))).toBe(true);
    expect(result.observationPartitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'error', resourceCount: 6 }),
    ]));

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects duplicate fields inside an explicit composite before any member can commit', async () => {
    const observedAt = new Date(Date.now() - 7 * 60 * 1000).toISOString();
    const bundle = heartRateBundle(observedAt, 80);
    const second = structuredClone(bundle.entry[0]);
    second.resource.id = 'obs-hr-overlap';
    second.resource.valueQuantity.value = 92;
    bundle.entry.push(second);
    bundle.entry.unshift({
      resource: {
        resourceType: 'Observation',
        id: `obs-duplicate-panel-${Date.now()}`,
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '85353-1' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: observedAt,
        hasMember: bundle.entry.map(({ resource }) => ({ reference: `Observation/${resource.id}` })),
      },
    });

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0].error).toMatch(/same canonical vital field/i);

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(0);
  });
});
