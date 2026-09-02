// Migration 755 journey proof: a governed manual FHIR import must commit its
// longitudinal medication history only with immutable document/resource
// receipts and canonical clinical evidence. Exact replay is read-only; changed
// authority or content under either identity fails closed.
//
// The receipt ledger is intentionally append-only, so this suite uses unique
// tenant/user/source identities and leaves its evidence for the ephemeral CI DB.

import crypto from 'node:crypto';

import { jest } from '@jest/globals';

import prisma, { ensureTenantRlsRuntimeRoleGrants, setTenantTx } from '../lib/prisma.js';
import { importFhirBundle } from '../services/import/patientDataImport.js';
import { clinicalImportSha256 } from '../services/import/clinicalImportReceiptService.js';
import {
  requestClinicalImportRetry,
  resolveClinicalImportReconciliation,
} from '../services/import/clinicalImportReconciliationService.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT_ID = crypto.randomUUID();
const PATIENT_UID = crypto.randomUUID();
const IMPORTER_UID = crypto.randomUUID();
const MEDICATION_RESOURCE_ID = crypto.randomUUID();
const SANITIZED_MEDICATION_RESOURCE_ID = crypto.randomUUID();
const CONDITION_RESOURCE_ID = crypto.randomUUID();
const ALLERGY_RESOURCE_ID = crypto.randomUUID();
const FIXTURE_SUFFIX = TENANT_ID.slice(0, 8);
const PATIENT_PHONE = `8${crypto.randomInt(100_000_000, 1_000_000_000)}`;
const IMPORTER_PHONE = `7${crypto.randomInt(100_000_000, 1_000_000_000)}`;
const SOURCE_DOCUMENT_ID = `fhir-receipt-${FIXTURE_SUFFIX}`;
const IDEMPOTENCY_KEY = `fhir-receipt-idempotency-${TENANT_ID}`;
const SUCCESS_OBSERVATION_ID = crypto.randomUUID();
const ATOMIC_OBSERVATION_ID = crypto.randomUUID();
const SUCCESS_OBSERVED_AT = '2026-08-29T10:15:00.000Z';
const ATOMIC_OBSERVED_AT = '2026-08-29T10:16:00.000Z';
const SUCCESS_OBSERVATION_SOURCE_SYSTEM = 'jest-clinical-import-observation-receipt';
const ATOMIC_OBSERVATION_SOURCE_SYSTEM = 'jest-clinical-import-observation-atomicity';
const MISSING_MEDICATION_ID_SOURCE_SYSTEM = 'jest-clinical-import-medication-missing-id';
const HELD_ASSERTION_SOURCE_SYSTEM = 'jest-clinical-import-held-assertions';
const SANITIZED_MEDICATION_SOURCE_SYSTEM = 'jest-clinical-import-sanitized-medication';
const AUTHORITY_GRANT_IDS = Object.freeze({
  'jest-clinical-import-receipts': crypto.randomUUID(),
  [SUCCESS_OBSERVATION_SOURCE_SYSTEM]: crypto.randomUUID(),
  [ATOMIC_OBSERVATION_SOURCE_SYSTEM]: crypto.randomUUID(),
  [MISSING_MEDICATION_ID_SOURCE_SYSTEM]: crypto.randomUUID(),
  [HELD_ASSERTION_SOURCE_SYSTEM]: crypto.randomUUID(),
  [SANITIZED_MEDICATION_SOURCE_SYSTEM]: crypto.randomUUID(),
});
const ACCESS_POLICY = Object.freeze({
  access_decision: 'allow',
  access_source: 'test_fixture_explicit_grant',
  policy_code: 'patient.record.upload',
  policy_version: '1',
  policy_hash: clinicalImportSha256('test-manual-clinical-import-policy-v1'),
  reason: 'Explicit test-only clinical import access evidence',
});

function reconciliationAccessDecision(patientUid) {
  return {
    ...ACCESS_POLICY,
    contract_version: 'clinical-import-reconciliation-access-decision-v1',
    actor_uid: IMPORTER_UID,
    patient_uid: patientUid,
  };
}

let patientId;
let facilityId;

async function query(sql, ...params) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

function fhirBundle({ medicationName = 'Metformin 500 mg tablet' } = {}) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        fullUrl: `urn:uuid:${PATIENT_UID}`,
        resource: {
          resourceType: 'Patient',
          id: PATIENT_UID,
          identifier: [{ system: 'urn:vhhealth:uid', value: PATIENT_UID }],
          active: true,
          name: [{ use: 'official', text: `Receipt Patient ${FIXTURE_SUFFIX}` }],
          telecom: [{ system: 'phone', value: PATIENT_PHONE, use: 'mobile' }],
        },
      },
      {
        fullUrl: `urn:uuid:${MEDICATION_RESOURCE_ID}`,
        resource: {
          resourceType: 'MedicationRequest',
          id: MEDICATION_RESOURCE_ID,
          status: 'active',
          intent: 'order',
          subject: { reference: `Patient/${PATIENT_UID}` },
          requester: { reference: `Practitioner/${IMPORTER_UID}` },
          authoredOn: '2026-08-31',
          medicationCodeableConcept: {
            coding: [{
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
              code: '860975',
              display: medicationName,
            }],
            text: medicationName,
          },
          dosageInstruction: [{ text: 'One tablet twice daily with meals' }],
          note: [{ text: 'Imported longitudinal medication history' }],
        },
      },
    ],
  };
}

function heartRateBundle({ id, effectiveDateTime, heartRate = 80 }) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id,
        status: 'final',
        category: [{ coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: 'vital-signs',
        }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        subject: { reference: `Patient/${PATIENT_UID}` },
        performer: [{ reference: `Practitioner/${IMPORTER_UID}` }],
        effectiveDateTime,
        valueQuantity: {
          value: heartRate,
          system: 'http://unitsofmeasure.org',
          code: '/min',
          unit: 'beats/minute',
        },
      },
    }],
  };
}

function heldClinicalAssertionBundle() {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    signature: {
      when: '2026-08-31T10:00:00.000Z',
      who: {
        identifier: {
          system: 'urn:vhhealth:test:source-author',
          value: `held-assertion-author-${FIXTURE_SUFFIX}`,
        },
        display: `Held Assertion Author ${FIXTURE_SUFFIX}`,
      },
    },
    entry: [
      {
        fullUrl: `urn:uuid:${PATIENT_UID}`,
        resource: {
          resourceType: 'Patient',
          id: PATIENT_UID,
          identifier: [{ system: 'urn:vhhealth:uid', value: PATIENT_UID }],
          active: true,
          name: [{ use: 'official', text: `Receipt Patient ${FIXTURE_SUFFIX}` }],
        },
      },
      {
        fullUrl: `urn:uuid:${CONDITION_RESOURCE_ID}`,
        resource: {
          resourceType: 'Condition',
          id: CONDITION_RESOURCE_ID,
          subject: { reference: `Patient/${PATIENT_UID}` },
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { text: 'Externally asserted condition awaiting governed promotion' },
        },
      },
      {
        fullUrl: `urn:uuid:${ALLERGY_RESOURCE_ID}`,
        resource: {
          resourceType: 'AllergyIntolerance',
          id: ALLERGY_RESOURCE_ID,
          patient: { reference: `Patient/${PATIENT_UID}` },
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { text: 'Externally asserted allergy awaiting governed promotion' },
        },
      },
    ],
  };
}

function authorityFor(bundle, {
  sourceSystem = 'jest-clinical-import-receipts',
  sourceDocumentId = SOURCE_DOCUMENT_ID,
  idempotencyKey = IDEMPOTENCY_KEY,
} = {}) {
  const sourcePayloadSha256 = clinicalImportSha256(bundle);
  const authorityGrantId = AUTHORITY_GRANT_IDS[sourceSystem];
  if (!authorityGrantId) throw new Error(`No test authority grant for ${sourceSystem}`);
  return {
    patientUid: PATIENT_UID,
    patientId,
    sourceSystem,
    sourceDocumentId,
    sourceFacilityId: facilityId,
    authorityGrantId,
    sourceSignatureSha256: clinicalImportSha256(`signature:${sourcePayloadSha256}`),
    sourcePayloadSha256,
    rawDocument: Buffer.from(JSON.stringify(bundle), 'utf8'),
    rawContentType: 'application/fhir+json',
    accessDecisionEvidence: ACCESS_POLICY,
    revalidateAccess: async () => ACCESS_POLICY,
    idempotencyKey,
    actorUid: IMPORTER_UID,
    actorRole: 'MEDICAL_RECORDS',
    ingestionMode: 'manual_medical_records',
    requestId: crypto.randomUUID(),
  };
}

async function expectPersistedCustody(receiptId, authority) {
  const rows = await query(
    `SELECT document.authority_grant_id, document.raw_artifact_id,
            document.access_decision_evidence, document.source_author_evidence,
            raw.patient_uid, raw.source_facility_id, raw.actor_uid,
            raw.source_system, raw.source_document_id, raw.document_format,
            raw.raw_payload_sha256, raw.raw_payload_bytes::int AS raw_payload_bytes,
            raw.raw_content_type, raw.canonicalization_version,
            raw.signature_verification_status,
            raw.canonical_payload_sha256, raw.source_author_evidence AS raw_source_author_evidence
       FROM clinical_import_document_receipts AS document
       JOIN clinical_import_raw_artifacts AS raw
         ON raw.tenant_id=document.tenant_id AND raw.id=document.raw_artifact_id
      WHERE document.tenant_id=$1::uuid AND document.id=$2::uuid`,
    TENANT_ID,
    receiptId,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    authority_grant_id: authority.authorityGrantId,
    patient_uid: PATIENT_UID,
    source_facility_id: facilityId,
    actor_uid: IMPORTER_UID,
    source_system: authority.sourceSystem,
    source_document_id: authority.sourceDocumentId,
    document_format: 'fhir_bundle',
    raw_payload_sha256: crypto.createHash('sha256').update(authority.rawDocument).digest('hex'),
    raw_payload_bytes: authority.rawDocument.length,
    raw_content_type: 'application/fhir+json',
    canonicalization_version: 'exact-http-body+fhir-canonical-json-v1',
    canonical_payload_sha256: authority.sourcePayloadSha256,
    signature_verification_status: 'asserted_unverified',
  });
  expect(rows[0].raw_artifact_id).toEqual(expect.any(String));
  expect(rows[0].access_decision_evidence).toMatchObject({
    contract_version: 'clinical-import-access-decision-v1',
    decision: 'allow',
    authority_grant_id: authority.authorityGrantId,
    patient_uid: PATIENT_UID,
    patient_access: ACCESS_POLICY,
  });
  expect(rows[0].source_author_evidence.authors).not.toHaveLength(0);
  expect(rows[0].raw_source_author_evidence).toEqual(rows[0].source_author_evidence);
}

d('migration 755 clinical import receipt journey (real PostgreSQL)', () => {
  beforeAll(async () => {
    const priorRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_runtime';
    try {
      const runtimeGrantResult = await ensureTenantRlsRuntimeRoleGrants();
      if (runtimeGrantResult.error) throw new Error(runtimeGrantResult.error);
    } finally {
      if (priorRuntimeRole == null) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = priorRuntimeRole;
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())`,
      TENANT_ID,
      `clinical-import-${FIXTURE_SUFFIX}`,
      `Clinical Import ${FIXTURE_SUFFIX}`,
    );

    await setTenantTx(TENANT_ID, async (tx) => {
      const users = await tx.$queryRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, name, role, is_active, status, is_deleted, updated_at)
         VALUES
           ($1::uuid, $3::uuid, $4, $6, 'PATIENT', TRUE, 'active', FALSE, NOW()),
           ($2::uuid, $3::uuid, $5, $7, 'MEDICAL_RECORDS', TRUE, 'active', FALSE, NOW())
         RETURNING id, uid`,
        PATIENT_UID,
        IMPORTER_UID,
        TENANT_ID,
        PATIENT_PHONE,
        IMPORTER_PHONE,
        `Receipt Patient ${FIXTURE_SUFFIX}`,
        `Receipt Importer ${FIXTURE_SUFFIX}`,
      );
      patientId = Number(users.find((row) => String(row.uid) === PATIENT_UID).id);

      const facilities = await tx.$queryRawUnsafe(
        `INSERT INTO facilities
           (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, $2, $3, 'active', FALSE)
         RETURNING id`,
        TENANT_ID,
        `IMPORT-${FIXTURE_SUFFIX}`,
        `Clinical Import Facility ${FIXTURE_SUFFIX}`,
      );
      facilityId = Number(facilities[0].id);

      for (const [sourceSystem, grantId] of Object.entries(AUTHORITY_GRANT_IDS)) {
        const ownerEvidenceRef = `test://clinical-import/${sourceSystem}/${grantId}`;
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
          TENANT_ID,
          grantId,
          PATIENT_UID,
          facilityId,
          IMPORTER_UID,
          sourceSystem,
          ownerEvidenceRef,
          clinicalImportSha256(ownerEvidenceRef),
          `Explicit test grant for ${sourceSystem}`,
          clinicalImportSha256(`grant:${TENANT_ID}:${grantId}`),
        );
      }
    });

    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS test_reject_atomic_fhir_observation_receipt_755
         ON public.clinical_import_document_receipts`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION public.test_reject_atomic_fhir_observation_receipt_755()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path = pg_catalog, public
       AS $$
       BEGIN
         IF NEW.source_system = 'jest-clinical-import-observation-atomicity' THEN
           RAISE EXCEPTION 'test-only atomic FHIR observation receipt rejection'
             USING ERRCODE = '23514';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_reject_atomic_fhir_observation_receipt_755
       BEFORE INSERT ON public.clinical_import_document_receipts
       FOR EACH ROW
       EXECUTE FUNCTION public.test_reject_atomic_fhir_observation_receipt_755()`,
    );
  });

  afterAll(async () => {
    try {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_reject_atomic_fhir_observation_receipt_755
           ON public.clinical_import_document_receipts`,
      );
    } finally {
      try {
        await prisma.$executeRawUnsafe(
          `DROP FUNCTION IF EXISTS public.test_reject_atomic_fhir_observation_receipt_755()`,
        );
      } finally {
        await prisma.$disconnect().catch(() => {});
      }
    }
  });

  it('keeps trusted receipt timestamps outside the runtime INSERT authority', async () => {
    const privileges = await prisma.$queryRawUnsafe(
      `SELECT has_table_privilege(
                'vhhealth_runtime', 'public.clinical_import_raw_artifacts', 'INSERT'
              ) AS raw_table_insert,
              has_column_privilege(
                'vhhealth_runtime', 'public.clinical_import_raw_artifacts', 'id', 'INSERT'
              ) AS raw_id_insert,
              has_column_privilege(
                'vhhealth_runtime', 'public.clinical_import_raw_artifacts', 'created_at', 'INSERT'
              ) AS raw_created_at_insert,
              has_table_privilege(
                'vhhealth_runtime', 'public.clinical_import_document_receipts', 'INSERT'
              ) AS document_table_insert,
              has_column_privilege(
                'vhhealth_runtime', 'public.clinical_import_document_receipts', 'id', 'INSERT'
              ) AS document_id_insert,
              has_column_privilege(
                'vhhealth_runtime', 'public.clinical_import_document_receipts', 'created_at', 'INSERT'
              ) AS document_created_at_insert`,
    );
    expect(privileges).toEqual([{
      raw_table_insert: false,
      raw_id_insert: true,
      raw_created_at_insert: false,
      document_table_insert: false,
      document_id_insert: true,
      document_created_at_insert: false,
    }]);

    for (const table of [
      'clinical_import_raw_artifacts',
      'clinical_import_document_receipts',
    ]) {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_runtime');
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_tenant_id', $1::text, true)`,
          TENANT_ID,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO public.${table} (created_at) VALUES (clock_timestamp())`,
        );
      })).rejects.toThrow(/permission denied/i);
    }
  });

  it('commits immutable receipt-bound history, replays exactly, and rejects every mutation path', async () => {
    const bundle = fhirBundle();
    const authority = authorityFor(bundle);

    const first = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(first).toMatchObject({
      imported: 1,
      deduplicated: 1,
      skipped: 0,
      errors: [],
      replayed: false,
    });
    expect(first.receipt_id).toEqual(expect.any(String));
    await expectPersistedCustody(first.receipt_id, authority);

    const documents = await query(
      `SELECT id, patient_id, patient_uid, actor_uid, actor_role, ingestion_mode,
              document_format, source_system, source_document_id,
              source_payload_sha256, source_identity_sha256,
              idempotency_key_sha256, resource_manifest_sha256,
              resource_manifest, result, canonical_timeline_event_id,
              canonical_audit_event_id
         FROM clinical_import_document_receipts
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      first.receipt_id,
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      patient_id: patientId,
      patient_uid: PATIENT_UID,
      actor_uid: IMPORTER_UID,
      actor_role: 'MEDICAL_RECORDS',
      ingestion_mode: 'manual_medical_records',
      document_format: 'fhir_bundle',
      source_system: 'jest-clinical-import-receipts',
      source_document_id: SOURCE_DOCUMENT_ID,
      source_payload_sha256: authority.sourcePayloadSha256,
      idempotency_key_sha256: clinicalImportSha256(IDEMPOTENCY_KEY),
    });
    expect(documents[0].resource_manifest).toHaveLength(2);
    expect(documents[0].result).toMatchObject({
      receipt_id: first.receipt_id,
      replayed: false,
    });

    const resources = await query(
      `SELECT id, source_resource_type, source_resource_id, source_resource_index,
              outcome, target_table, target_id, canonical_timeline_event_id,
              canonical_audit_event_id
         FROM clinical_import_resource_receipts
        WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid
        ORDER BY source_resource_index`,
      TENANT_ID,
      first.receipt_id,
    );
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      source_resource_type: 'Patient',
      source_resource_id: PATIENT_UID,
      source_resource_index: 0,
      outcome: 'deduplicated',
      target_table: 'users',
      target_id: String(patientId),
      canonical_timeline_event_id: null,
      canonical_audit_event_id: null,
    });
    expect(resources[1]).toMatchObject({
      source_resource_type: 'MedicationRequest',
      source_resource_id: MEDICATION_RESOURCE_ID,
      source_resource_index: 1,
      outcome: 'imported',
      target_table: 'e_prescriptions',
    });
    expect(resources[1].target_id).toEqual(expect.any(String));
    expect(resources[1].canonical_timeline_event_id).toEqual(expect.any(String));
    expect(resources[1].canonical_audit_event_id).toEqual(expect.any(String));
    expect(first.resource_receipts).toEqual(resources.map((resource) => ({
      id: resource.id,
      source_resource_type: resource.source_resource_type,
      source_resource_id: resource.source_resource_id,
      source_resource_index: resource.source_resource_index,
      outcome: resource.outcome,
      target_table: resource.target_table,
      target_id: resource.target_id,
    })));
    expect(first.reconciliation_items).toEqual([]);

    const medicationId = resources[1].target_id;
    const medications = await query(
      `SELECT id, patient_id, patient_uid, medication_name, medications,
              lifecycle_status, pharmacy_order_id, pharmacy_opted,
              appointment_id, admission_id, signed_at, signed_by, locked_at, locked_by
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      medicationId,
    );
    expect(medications).toHaveLength(1);
    expect(medications[0]).toMatchObject({
      patient_id: patientId,
      patient_uid: PATIENT_UID,
      medication_name: 'Metformin 500 mg tablet',
      lifecycle_status: 'imported_history',
      pharmacy_order_id: null,
      pharmacy_opted: false,
      appointment_id: null,
      admission_id: null,
      signed_at: null,
      signed_by: null,
      locked_at: null,
      locked_by: null,
    });
    expect(medications[0].medications[0].import_receipt).toMatchObject({
      source_resource_id: MEDICATION_RESOURCE_ID,
      document_source_identity_sha256: documents[0].source_identity_sha256,
      resource_manifest_sha256: documents[0].resource_manifest_sha256,
      idempotency_key_sha256: clinicalImportSha256(IDEMPOTENCY_KEY),
    });
    expect(medications[0].medications[0].import_receipt).not.toHaveProperty('idempotency_key');

    const documentTimeline = await query(
      `SELECT id, event_type, source_table, source_id, actor_uid
         FROM clinical_timeline_events
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      documents[0].canonical_timeline_event_id,
    );
    expect(documentTimeline).toEqual([expect.objectContaining({
      event_type: 'clinical_document.imported',
      source_table: 'clinical_import_document_receipts',
      source_id: first.receipt_id,
      actor_uid: IMPORTER_UID,
    })]);
    const documentAudit = await query(
      `SELECT id, action, resource_table, resource_id, actor_uid
         FROM clinical_audit_events
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      documents[0].canonical_audit_event_id,
    );
    expect(documentAudit).toEqual([expect.objectContaining({
      action: 'clinical_document.imported',
      resource_table: 'clinical_import_document_receipts',
      resource_id: first.receipt_id,
      actor_uid: IMPORTER_UID,
    })]);

    const medicationTimeline = await query(
      `SELECT id, event_type, source_table, source_id, actor_uid
         FROM clinical_timeline_events
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      resources[1].canonical_timeline_event_id,
    );
    expect(medicationTimeline).toEqual([expect.objectContaining({
      event_type: 'medication.history_imported',
      source_table: 'e_prescriptions',
      source_id: medicationId,
      actor_uid: IMPORTER_UID,
    })]);
    const medicationAudit = await query(
      `SELECT id, action, resource_table, resource_id, actor_uid
         FROM clinical_audit_events
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      resources[1].canonical_audit_event_id,
    );
    expect(medicationAudit).toEqual([expect.objectContaining({
      action: 'medication.history_imported',
      resource_table: 'e_prescriptions',
      resource_id: medicationId,
      actor_uid: IMPORTER_UID,
    })]);

    const beforeReplay = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid) AS document_count,
         (SELECT COUNT(*)::int FROM clinical_import_resource_receipts
           WHERE tenant_id=$1::uuid) AS resource_count,
         (SELECT COUNT(*)::int FROM e_prescriptions
           WHERE tenant_id=$1::uuid AND id=$2::int) AS medication_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$1::uuid
             AND id IN ($3::uuid, $4::uuid)) AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id=$1::uuid
             AND id IN ($5::uuid, $6::uuid)) AS audit_count`,
      TENANT_ID,
      medicationId,
      documents[0].canonical_timeline_event_id,
      resources[1].canonical_timeline_event_id,
      documents[0].canonical_audit_event_id,
      resources[1].canonical_audit_event_id,
    );

    const replay = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(replay.resource_receipts).toEqual(first.resource_receipts);
    expect(replay.reconciliation_items).toEqual(first.reconciliation_items);

    const afterReplay = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid) AS document_count,
         (SELECT COUNT(*)::int FROM clinical_import_resource_receipts
           WHERE tenant_id=$1::uuid) AS resource_count,
         (SELECT COUNT(*)::int FROM e_prescriptions
           WHERE tenant_id=$1::uuid AND id=$2::int) AS medication_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$1::uuid
             AND id IN ($3::uuid, $4::uuid)) AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id=$1::uuid
             AND id IN ($5::uuid, $6::uuid)) AS audit_count`,
      TENANT_ID,
      medicationId,
      documents[0].canonical_timeline_event_id,
      resources[1].canonical_timeline_event_id,
      documents[0].canonical_audit_event_id,
      resources[1].canonical_audit_event_id,
    );
    expect(afterReplay).toEqual(beforeReplay);
    expect(afterReplay[0]).toEqual({
      document_count: 1,
      resource_count: 2,
      medication_count: 1,
      timeline_count: 2,
      audit_count: 2,
    });

    await expect(importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: {
        ...authority,
        rawContentType: 'application/json',
      },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    const modifiedBundle = fhirBundle({ medicationName: 'Metformin 850 mg tablet' });
    const modifiedAuthority = authorityFor(modifiedBundle, {
      sourceDocumentId: `${SOURCE_DOCUMENT_ID}-changed`,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await expect(importFhirBundle(modifiedBundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: modifiedAuthority,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    await expect(setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `UPDATE clinical_import_document_receipts SET status=status
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      first.receipt_id,
    ))).rejects.toThrow(/clinical_import_document_receipts is append-only/i);
    await expect(setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM clinical_import_resource_receipts
        WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid`,
      TENANT_ID,
      first.receipt_id,
    ))).rejects.toThrow(/clinical_import_resource_receipts is append-only/i);

    await expect(setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `UPDATE e_prescriptions SET notes=notes
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      medicationId,
    ))).rejects.toThrow(/imported medication history is immutable/i);
    await expect(setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      medicationId,
    ))).rejects.toThrow(/imported medication history is immutable/i);

    const orphanPrescriptionNumber = `IMP-UNRECEIPTED-${FIXTURE_SUFFIX}`;
    const missingReceipt = {
      contract_version: 'clinical-import-resource-v1',
      source_resource_type: 'MedicationRequest',
      source_resource_id: crypto.randomUUID(),
      source_identity_sha256: 'a'.repeat(64),
      payload_sha256: 'b'.repeat(64),
      document_source_identity_sha256: 'c'.repeat(64),
      resource_manifest_sha256: 'd'.repeat(64),
      idempotency_key_sha256: 'e'.repeat(64),
      imported_by_uid: IMPORTER_UID,
      actor_role: 'MEDICAL_RECORDS',
      ingestion_mode: 'manual_medical_records',
    };
    await expect(setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (tenant_id, patient_id, patient_uid, medication_name, medications,
          clinical_notes, notes, status, lifecycle_status, prescription_number,
          pharmacy_opted, created_at, updated_at)
       VALUES
         ($1::uuid, $2::int, $3::uuid, 'Unreceipted medication', $4::jsonb,
          'Direct SQL must fail closed', 'Direct SQL must fail closed', 'active',
          'imported_history', $5, FALSE, NOW(), NOW())`,
      TENANT_ID,
      patientId,
      PATIENT_UID,
      JSON.stringify([{
        name: 'Unreceipted medication',
        source: 'FHIR_MedicationRequest',
        import_receipt: missingReceipt,
      }]),
      orphanPrescriptionNumber,
    ))).rejects.toThrow(/no matching immutable document and resource receipt/i);

    const orphanRows = await query(
      `SELECT id FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND prescription_number=$2`,
      TENANT_ID,
      orphanPrescriptionNumber,
    );
    expect(orphanRows).toEqual([]);
  });

  it('binds a successful FHIR Observation receipt to held vitals without pre-verification effects', async () => {
    const bundle = heartRateBundle({
      id: SUCCESS_OBSERVATION_ID,
      effectiveDateTime: SUCCESS_OBSERVED_AT,
    });
    const sourceDocumentId = `${SOURCE_DOCUMENT_ID}-observation-success`;
    const authority = authorityFor(bundle, {
      sourceSystem: SUCCESS_OBSERVATION_SOURCE_SYSTEM,
      sourceDocumentId,
      idempotencyKey: `${IDEMPOTENCY_KEY}-observation-success`,
    });

    const result = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(result).toMatchObject({
      imported: 1,
      deduplicated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      replayed: false,
    });
    await expectPersistedCustody(result.receipt_id, authority);

    const documents = await query(
      `SELECT id, source_system, source_document_id,
              canonical_timeline_event_id, canonical_audit_event_id
         FROM clinical_import_document_receipts
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      result.receipt_id,
    );
    expect(documents).toEqual([expect.objectContaining({
      source_system: SUCCESS_OBSERVATION_SOURCE_SYSTEM,
      source_document_id: sourceDocumentId,
    })]);

    const resources = await query(
      `SELECT source_resource_type, source_resource_id, outcome,
              target_table, target_id, canonical_timeline_event_id,
              canonical_audit_event_id
         FROM clinical_import_resource_receipts
        WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid`,
      TENANT_ID,
      result.receipt_id,
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      source_resource_type: 'Observation',
      source_resource_id: SUCCESS_OBSERVATION_ID,
      outcome: 'imported',
      target_table: 'vitals_chart',
    });
    expect(resources[0].target_id).toEqual(expect.any(String));
    expect(resources[0].canonical_timeline_event_id).toEqual(expect.any(String));
    expect(resources[0].canonical_audit_event_id).toEqual(expect.any(String));

    const vitalsId = resources[0].target_id;
    const vitals = await query(
      `SELECT id, patient_uid, heart_rate, source, source_device, recorded_at,
              device_verified
         FROM vitals_chart
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      vitalsId,
    );
    expect(vitals).toHaveLength(1);
    expect(vitals[0]).toMatchObject({
      patient_uid: PATIENT_UID,
      source: 'fhir',
      device_verified: false,
    });
    expect(Number(vitals[0].heart_rate)).toBe(80);
    expect(vitals[0].source_device).toMatch(/^fhir-set:/);
    expect(new Date(vitals[0].recorded_at).toISOString()).toBe(SUCCESS_OBSERVED_AT);

    const observationSets = await query(
      `SELECT observation_set.set_fingerprint, observation_set.vitals_chart_id,
              observation_set.news2_effects_completed_at,
              observation_set.anomaly_effects_completed_at,
              COUNT(resources.resource_fingerprint)::int AS resource_count
         FROM fhir_vital_observation_sets AS observation_set
         JOIN fhir_vital_observation_set_resources AS resources
           ON resources.tenant_id=observation_set.tenant_id
          AND resources.set_fingerprint=observation_set.set_fingerprint
        WHERE observation_set.tenant_id=$1::uuid
          AND observation_set.vitals_chart_id=$2::int
        GROUP BY observation_set.set_fingerprint, observation_set.vitals_chart_id,
                 observation_set.news2_effects_completed_at,
                 observation_set.anomaly_effects_completed_at`,
      TENANT_ID,
      vitalsId,
    );
    expect(observationSets).toHaveLength(1);
    expect(observationSets[0]).toMatchObject({
      vitals_chart_id: Number(vitalsId),
      resource_count: 1,
    });
    expect(observationSets[0].news2_effects_completed_at).toBeNull();
    expect(observationSets[0].anomaly_effects_completed_at).toBeNull();

    const news2 = await query(
      `SELECT id, patient_uid, heart_rate, total_score, partial_score, vitals_chart_id
         FROM news2_scores
        WHERE tenant_id=$1::uuid AND vitals_chart_id=$2::int`,
      TENANT_ID,
      vitalsId,
    );
    expect(news2).toEqual([]);
    const alerts = await query(
      `SELECT id FROM clinical_alerts
        WHERE tenant_id=$1::uuid AND source_vitals_chart_id=$2::int`,
      TENANT_ID,
      vitalsId,
    );
    expect(alerts).toEqual([]);

    const timeline = await query(
      `SELECT id, event_type, event_status, source_table, source_id, payload, tags
         FROM clinical_timeline_events
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      resources[0].canonical_timeline_event_id,
    );
    expect(timeline).toEqual([expect.objectContaining({
      event_type: 'vitals.recorded',
      event_status: 'unverified',
      source_table: 'vitals_chart',
      source_id: vitalsId,
      payload: expect.objectContaining({
        source_kind: 'fhir',
        verification_status: 'unverified',
      }),
      tags: expect.arrayContaining(['vitals', 'fhir-imported', 'unverified']),
    })]);
    const audit = await query(
      `SELECT id, action, resource_table, resource_id
         FROM clinical_audit_events
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      resources[0].canonical_audit_event_id,
    );
    expect(audit).toEqual([expect.objectContaining({
      action: 'vitals.recorded',
      resource_table: 'vitals_chart',
      resource_id: vitalsId,
    })]);
  });

  it('rolls back vitals, NEWS2, canonical, FHIR-set, and receipt rows when the document receipt is rejected', async () => {
    const bundle = heartRateBundle({
      id: ATOMIC_OBSERVATION_ID,
      effectiveDateTime: ATOMIC_OBSERVED_AT,
      heartRate: 82,
    });
    const sourceDocumentId = `${SOURCE_DOCUMENT_ID}-observation-atomicity`;
    const authority = authorityFor(bundle, {
      sourceSystem: ATOMIC_OBSERVATION_SOURCE_SYSTEM,
      sourceDocumentId,
      idempotencyKey: `${IDEMPOTENCY_KEY}-observation-atomicity`,
    });
    const atomicState = () => query(
      `SELECT
         (SELECT COUNT(*)::int FROM vitals_chart
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND source='fhir' AND recorded_at=$3::timestamptz) AS vitals_count,
         (SELECT COUNT(*)::int FROM news2_scores
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND recorded_at=$3::timestamptz) AS news2_count,
         (SELECT COUNT(*)::int FROM fhir_vital_observation_sets
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND observed_at=$3::timestamptz) AS observation_set_count,
         (SELECT COUNT(*)::int FROM fhir_vital_observation_receipts
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND resource_id=$4) AS observation_receipt_count,
         (SELECT COUNT(*)::int
            FROM fhir_vital_observation_set_resources AS set_resource
            JOIN fhir_vital_observation_receipts AS receipt
              ON receipt.tenant_id=set_resource.tenant_id
             AND receipt.resource_fingerprint=set_resource.resource_fingerprint
           WHERE receipt.tenant_id=$1::uuid AND receipt.patient_uid=$2::uuid
             AND receipt.resource_id=$4) AS observation_set_resource_count,
         (SELECT COUNT(*)::int FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid AND source_system=$5
             AND source_document_id=$6) AS document_receipt_count,
         (SELECT COUNT(*)::int FROM clinical_import_resource_receipts
           WHERE tenant_id=$1::uuid AND source_resource_id=$4) AS resource_receipt_count,
         (SELECT COUNT(*)::int FROM clinical_import_raw_artifacts
           WHERE tenant_id=$1::uuid AND source_system=$5
             AND source_document_id=$6) AS raw_artifact_count,
         (SELECT COUNT(*)::int FROM clinical_import_reconciliation_items
           WHERE tenant_id=$1::uuid) AS reconciliation_item_count,
         (SELECT COUNT(*)::int FROM clinical_import_reconciliation_events
           WHERE tenant_id=$1::uuid) AS reconciliation_event_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND event_type='vitals.recorded') AS vitals_timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND action='vitals.recorded') AS vitals_audit_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND event_type='clinical_document.imported') AS document_timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid
             AND action='clinical_document.imported') AS document_audit_count`,
      TENANT_ID,
      PATIENT_UID,
      ATOMIC_OBSERVED_AT,
      ATOMIC_OBSERVATION_ID,
      ATOMIC_OBSERVATION_SOURCE_SYSTEM,
      sourceDocumentId,
    );

    const before = await atomicState();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      vitals_count: 0,
      news2_count: 0,
      observation_set_count: 0,
      observation_receipt_count: 0,
      observation_set_resource_count: 0,
      document_receipt_count: 0,
      resource_receipt_count: 0,
      raw_artifact_count: 0,
      reconciliation_item_count: 0,
      reconciliation_event_count: 0,
    });

    await expect(importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    })).rejects.toThrow(/test-only atomic FHIR observation receipt rejection/i);

    const after = await atomicState();
    expect(after).toEqual(before);
  });

  it('persists a missing MedicationRequest stable id as a durable partial failure', async () => {
    const bundle = fhirBundle();
    delete bundle.entry[1].resource.id;
    const sourceDocumentId = `${SOURCE_DOCUMENT_ID}-medication-missing-id`;
    const authority = authorityFor(bundle, {
      sourceSystem: MISSING_MEDICATION_ID_SOURCE_SYSTEM,
      sourceDocumentId,
      idempotencyKey: `${IDEMPOTENCY_KEY}-medication-missing-id`,
    });

    const result = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(result).toMatchObject({
      imported: 0,
      deduplicated: 1,
      skipped: 0,
      failed: 1,
      replayed: false,
      errors: [expect.objectContaining({
        resource: 'MedicationRequest',
        error: 'FHIR resource import failed',
        code: 'IMPORT_SOURCE_RESOURCE_ID_REQUIRED',
      })],
    });
    expect(result.resource_receipts).toHaveLength(2);
    expect(result.resource_receipts[1]).toMatchObject({
      source_resource_type: 'MedicationRequest',
      source_resource_id: null,
      source_resource_index: 1,
      outcome: 'failed',
      target_table: null,
      target_id: null,
    });
    expect(result.reconciliation_items).toEqual([expect.objectContaining({
      resource_receipt_id: result.resource_receipts[1].id,
      status: 'OPENED',
    })]);
    await expectPersistedCustody(result.receipt_id, authority);

    const failure = await query(
      `SELECT document.status AS document_status,
              resource.source_resource_type, resource.source_resource_id,
              resource.source_resource_index, resource.outcome,
              resource.target_table, resource.target_id, resource.evidence,
              item.id AS reconciliation_item_id,
              event.id AS reconciliation_event_id,
              event.event_type, event.evidence AS reconciliation_evidence
         FROM clinical_import_document_receipts AS document
         JOIN clinical_import_resource_receipts AS resource
           ON resource.tenant_id=document.tenant_id
          AND resource.document_receipt_id=document.id
         JOIN clinical_import_reconciliation_items AS item
           ON item.tenant_id=resource.tenant_id
          AND item.resource_receipt_id=resource.id
         JOIN clinical_import_reconciliation_events AS event
           ON event.tenant_id=item.tenant_id
          AND event.reconciliation_item_id=item.id
        WHERE document.tenant_id=$1::uuid
          AND document.id=$2::uuid
          AND resource.source_resource_index=1`,
      TENANT_ID,
      result.receipt_id,
    );
    expect(failure).toEqual([expect.objectContaining({
      document_status: 'completed_with_errors',
      source_resource_type: 'MedicationRequest',
      source_resource_id: null,
      source_resource_index: 1,
      outcome: 'failed',
      target_table: null,
      target_id: null,
      reconciliation_item_id: result.reconciliation_items[0].id,
      reconciliation_event_id: result.reconciliation_items[0].opened_event_id,
      event_type: 'OPENED',
      evidence: expect.objectContaining({
        error: 'FHIR resource import failed',
        error_code: 'IMPORT_SOURCE_RESOURCE_ID_REQUIRED',
        error_status_code: 400,
      }),
      reconciliation_evidence: expect.objectContaining({
        contract_version: 'clinical-import-reconciliation-opened-v1',
        source_resource_type: 'MedicationRequest',
        source_resource_id: null,
        source_resource_index: 1,
        error: 'FHIR resource import failed',
        error_code: 'IMPORT_SOURCE_RESOURCE_ID_REQUIRED',
      }),
    })]);
  });

  it('closes a missing-ID failure through governed retry and a typed replacement receipt', async () => {
    const failedBundle = fhirBundle();
    delete failedBundle.entry[1].resource.id;
    const failedAuthority = authorityFor(failedBundle, {
      sourceSystem: MISSING_MEDICATION_ID_SOURCE_SYSTEM,
      sourceDocumentId: `${SOURCE_DOCUMENT_ID}-missing-id-closure`,
      idempotencyKey: `${IDEMPOTENCY_KEY}-missing-id-closure`,
    });
    const failed = await importFhirBundle(failedBundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: failedAuthority,
    });
    const item = failed.reconciliation_items[0];
    expect(item).toEqual(expect.objectContaining({ status: 'OPENED' }));

    const retry = await requestClinicalImportRetry({
      tenantId: TENANT_ID,
      itemId: item.id,
      actorUid: IMPORTER_UID,
      actorRole: 'MEDICAL_RECORDS',
      reason: 'Correct the missing MedicationRequest source identifier and resubmit',
      idempotencyKey: `${IDEMPOTENCY_KEY}-missing-id-retry-action`,
      authorityGrantId: failedAuthority.authorityGrantId,
      revalidateAccess: async ({ context }) => (
        reconciliationAccessDecision(context.activePatientUid)
      ),
    });
    expect(retry).toMatchObject({
      replayed: false,
      event: {
        event_type: 'RETRY_REQUESTED',
        replacement_resource_receipt_id: null,
      },
      next_action: expect.objectContaining({
        action: 'MANUAL_RESUBMISSION_REQUIRED',
      }),
    });
    expect(retry.event).not.toHaveProperty('evidence');
    expect(retry.event.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);

    const unboundReceipt = failed.resource_receipts.find(
      receipt => receipt.source_resource_type === 'Patient',
    );
    expect(unboundReceipt).toBeDefined();
    const bypassReason = 'Attempted direct resolution with an unbound import receipt';
    const bypassEvidence = {
      contract_version: 'clinical-import-reconciliation-event-v1',
      request: {
        event_type: 'RESOLVED',
        reason: bypassReason,
        authority_grant_id: failedAuthority.authorityGrantId,
        replacement_resource_receipt_id: unboundReceipt.id,
      },
      custody: {
        historical_patient_uid: PATIENT_UID,
        active_survivor_patient_uid: PATIENT_UID,
      },
      replacement_receipt: {
        resource_receipt_id: unboundReceipt.id,
        correction_reconciliation_item_id: item.id,
        correction_original_resource_receipt_id: item.resource_receipt_id,
        correction_retry_event_id: retry.event.id,
      },
    };
    await expect(query(
      `INSERT INTO clinical_import_reconciliation_events
         (tenant_id, reconciliation_item_id, resource_receipt_id,
          document_receipt_id, patient_uid, facility_id, event_type,
          actor_uid, actor_role, reason, predecessor_event_id,
          replacement_resource_receipt_id, idempotency_key_sha256,
          evidence, contract_version)
       SELECT tenant_id, id, resource_receipt_id, document_receipt_id,
              patient_uid, facility_id, 'RESOLVED', $3::uuid,
              'MEDICAL_RECORDS', $4, $5::uuid, $6::uuid, $7,
              $8::jsonb, 1
         FROM clinical_import_reconciliation_items
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      item.id,
      IMPORTER_UID,
      bypassReason,
      retry.event.id,
      unboundReceipt.id,
      clinicalImportSha256(`${IDEMPOTENCY_KEY}-unbound-resolution-bypass`),
      JSON.stringify(bypassEvidence),
    )).rejects.toMatchObject({ code: '23514' });

    const replacementBundle = fhirBundle();
    const replacementAuthority = authorityFor(replacementBundle, {
      sourceSystem: MISSING_MEDICATION_ID_SOURCE_SYSTEM,
      sourceDocumentId: `${SOURCE_DOCUMENT_ID}-missing-id-replacement`,
      idempotencyKey: `${IDEMPOTENCY_KEY}-missing-id-replacement`,
    });
    replacementAuthority.correctionItemId = item.id;
    replacementAuthority.correctionManifestIndex = 1;
    const replacement = await importFhirBundle(replacementBundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: replacementAuthority,
    });
    const replacementReceipt = replacement.resource_receipts.find(
      receipt => receipt.source_resource_type === 'MedicationRequest',
    );
    expect(replacementReceipt).toEqual(expect.objectContaining({
      source_resource_id: MEDICATION_RESOURCE_ID,
      source_resource_index: 1,
      outcome: expect.stringMatching(/^(?:imported|deduplicated)$/),
    }));
    const correctionBinding = await query(
      `SELECT correction_reconciliation_item_id,
              correction_original_resource_receipt_id,
              correction_retry_event_id
         FROM clinical_import_resource_receipts
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      replacementReceipt.id,
    );
    expect(correctionBinding).toEqual([expect.objectContaining({
      correction_reconciliation_item_id: item.id,
      correction_original_resource_receipt_id: item.resource_receipt_id,
      correction_retry_event_id: retry.event.id,
    })]);

    await expect(requestClinicalImportRetry({
      tenantId: TENANT_ID,
      itemId: item.id,
      actorUid: IMPORTER_UID,
      actorRole: 'MEDICAL_RECORDS',
      reason: 'Attempt another retry after the committed correction already exists',
      idempotencyKey: `${IDEMPOTENCY_KEY}-missing-id-stranding-retry`,
      authorityGrantId: failedAuthority.authorityGrantId,
      revalidateAccess: async ({ context }) => (
        reconciliationAccessDecision(context.activePatientUid)
      ),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECONCILIATION_CORRECTION_PENDING_RESOLUTION',
    });

    const resolved = await resolveClinicalImportReconciliation({
      tenantId: TENANT_ID,
      itemId: item.id,
      actorUid: IMPORTER_UID,
      actorRole: 'MEDICAL_RECORDS',
      reason: 'Verified the corrected MedicationRequest receipt and closed the failure',
      idempotencyKey: `${IDEMPOTENCY_KEY}-missing-id-resolution`,
      authorityGrantId: failedAuthority.authorityGrantId,
      replacementResourceReceiptId: replacementReceipt.id,
      revalidateAccess: async ({ context }) => (
        reconciliationAccessDecision(context.activePatientUid)
      ),
    });
    expect(resolved).toMatchObject({
      replayed: false,
      next_action: null,
      event: {
        event_type: 'RESOLVED',
        replacement_resource_receipt_id: replacementReceipt.id,
      },
    });
    expect(resolved.event).not.toHaveProperty('evidence');
    expect(resolved.event.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);

    const persisted = await query(
      `SELECT event_type, predecessor_event_id, replacement_resource_receipt_id,
              evidence_sha256
         FROM clinical_import_reconciliation_events
        WHERE tenant_id=$1::uuid AND reconciliation_item_id=$2::uuid
        ORDER BY created_at, id`,
      TENANT_ID,
      item.id,
    );
    expect(persisted.map(event => event.event_type)).toEqual([
      'OPENED',
      'RETRY_REQUESTED',
      'RESOLVED',
    ]);
    expect(persisted[2]).toMatchObject({
      predecessor_event_id: retry.event.id,
      replacement_resource_receipt_id: replacementReceipt.id,
    });
    expect(persisted[2].evidence_sha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(query(
      `INSERT INTO clinical_import_reconciliation_events
         (tenant_id, reconciliation_item_id, resource_receipt_id,
          document_receipt_id, patient_uid, facility_id, event_type,
          actor_uid, actor_role, reason, predecessor_event_id,
          replacement_resource_receipt_id, idempotency_key_sha256,
          evidence, contract_version)
       SELECT tenant_id, id, resource_receipt_id, document_receipt_id,
              patient_uid, facility_id, 'SUPERSEDED', $3::uuid,
              'MEDICAL_RECORDS', $4, $5::uuid, NULL, $6,
              jsonb_build_object('contract_version',
                'clinical-import-reconciliation-event-v1'), 1
         FROM clinical_import_reconciliation_items
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      TENANT_ID,
      item.id,
      IMPORTER_UID,
      'Attempted terminal supersession without named owner authority',
      resolved.event.id,
      clinicalImportSha256(`${IDEMPOTENCY_KEY}-unauthorized-supersession`),
    )).rejects.toThrow();
  });

  it('rejects the authority lock helper before querying a different tenant', async () => {
    await expect(setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT public.lock_clinical_import_authority_760(
         $1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, $6, $7
       ) AS owner_evidence_sha256`,
      crypto.randomUUID(),
      crypto.randomUUID(),
      PATIENT_UID,
      facilityId,
      IMPORTER_UID,
      MISSING_MEDICATION_ID_SOURCE_SYSTEM,
      'fhir_bundle',
    ))).rejects.toThrow(/tenant context is unavailable or mismatched/i);
  });

  it('holds Condition and AllergyIntolerance as durable failed receipts for governed promotion', async () => {
    const bundle = heldClinicalAssertionBundle();
    const sourceDocumentId = `${SOURCE_DOCUMENT_ID}-held-assertions`;
    const authority = authorityFor(bundle, {
      sourceSystem: HELD_ASSERTION_SOURCE_SYSTEM,
      sourceDocumentId,
      idempotencyKey: `${IDEMPOTENCY_KEY}-held-assertions`,
    });

    const result = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(result).toMatchObject({
      imported: 0,
      deduplicated: 1,
      skipped: 0,
      failed: 2,
      replayed: false,
    });
    expect(result.errors).toEqual([
      expect.objectContaining({
        resource: 'Condition',
        id: CONDITION_RESOURCE_ID,
        code: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      }),
      expect.objectContaining({
        resource: 'AllergyIntolerance',
        id: ALLERGY_RESOURCE_ID,
        code: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
      }),
    ]);
    expect(result.resource_receipts).toHaveLength(3);
    expect(result.reconciliation_items).toHaveLength(2);
    await expectPersistedCustody(result.receipt_id, authority);

    const heldRows = await query(
      `SELECT resource.id AS resource_receipt_id,
              resource.source_resource_type, resource.source_resource_id,
              resource.source_resource_index, resource.outcome,
              resource.target_table, resource.target_id, resource.evidence,
              item.id AS reconciliation_item_id,
              event.id AS reconciliation_event_id,
              event.event_type, event.evidence AS reconciliation_evidence
         FROM clinical_import_resource_receipts AS resource
         JOIN clinical_import_reconciliation_items AS item
           ON item.tenant_id=resource.tenant_id
          AND item.resource_receipt_id=resource.id
         JOIN clinical_import_reconciliation_events AS event
           ON event.tenant_id=item.tenant_id
          AND event.reconciliation_item_id=item.id
        WHERE resource.tenant_id=$1::uuid
          AND resource.document_receipt_id=$2::uuid
          AND resource.outcome='failed'
        ORDER BY resource.source_resource_index`,
      TENANT_ID,
      result.receipt_id,
    );
    expect(heldRows).toHaveLength(2);
    const expectedAssertions = [
      { resourceType: 'Condition', resourceId: CONDITION_RESOURCE_ID, sourceIndex: 1 },
      { resourceType: 'AllergyIntolerance', resourceId: ALLERGY_RESOURCE_ID, sourceIndex: 2 },
    ];
    for (const [index, expected] of expectedAssertions.entries()) {
      const row = heldRows[index];
      expect(row).toMatchObject({
        source_resource_type: expected.resourceType,
        source_resource_id: expected.resourceId,
        source_resource_index: expected.sourceIndex,
        outcome: 'failed',
        target_table: null,
        target_id: null,
        event_type: 'OPENED',
        evidence: expect.objectContaining({
          status: 'HELD_EXTERNAL_AUTHORITY',
          required_authority: 'CLINICAL_IMPORT_ASSERTION_PROMOTION_OWNER',
          resource_type: expected.resourceType,
          resource_id: expected.resourceId,
          error_code: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
          error_status_code: 409,
        }),
        reconciliation_evidence: expect.objectContaining({
          contract_version: 'clinical-import-reconciliation-opened-v1',
          source_resource_type: expected.resourceType,
          source_resource_id: expected.resourceId,
          source_resource_index: expected.sourceIndex,
          error_code: 'IMPORT_CLINICAL_ASSERTION_REVIEW_REQUIRED',
        }),
      });
      expect(row.resource_receipt_id).toEqual(result.resource_receipts[index + 1].id);
      expect(row.reconciliation_item_id).toEqual(result.reconciliation_items[index].id);
      expect(row.reconciliation_event_id).toEqual(result.reconciliation_items[index].opened_event_id);
    }
  });

  it('sanitizes promoted MedicationRequest fields without changing exact raw custody', async () => {
    const bundle = fhirBundle({
      medicationName: 'Metformin <b>500 mg</b><script>alert(1)</script>',
    });
    bundle.entry[1].fullUrl = `urn:uuid:${SANITIZED_MEDICATION_RESOURCE_ID}`;
    bundle.entry[1].resource.id = SANITIZED_MEDICATION_RESOURCE_ID;
    bundle.entry[1].resource.dosageInstruction = [{
      text: '<img src=x onerror=alert(1)>One tablet <strong>daily</strong>',
    }];
    bundle.entry[1].resource.note = [{
      text: '<a href="javascript:alert(1)">External medication note</a>',
    }];
    const authority = authorityFor(bundle, {
      sourceSystem: SANITIZED_MEDICATION_SOURCE_SYSTEM,
      sourceDocumentId: `${SOURCE_DOCUMENT_ID}-sanitized-medication`,
      idempotencyKey: `${IDEMPOTENCY_KEY}-sanitized-medication`,
    });
    expect(authority.rawDocument.toString('utf8')).toContain('<script>alert(1)</script>');
    expect(authority.rawDocument.toString('utf8')).toContain('onerror=alert(1)');

    const result = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(result).toMatchObject({
      imported: 1,
      deduplicated: 1,
      failed: 0,
      errors: [],
      replayed: false,
    });
    await expectPersistedCustody(result.receipt_id, authority);

    const medicationReceipt = result.resource_receipts.find(
      (receipt) => receipt.source_resource_type === 'MedicationRequest',
    );
    expect(medicationReceipt).toMatchObject({
      source_resource_id: SANITIZED_MEDICATION_RESOURCE_ID,
      outcome: 'imported',
      target_table: 'e_prescriptions',
    });
    const medications = await query(
      `SELECT medication_name, medications, clinical_notes, notes
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      medicationReceipt.target_id,
    );
    expect(medications).toHaveLength(1);
    const promotedFields = [
      medications[0].medication_name,
      medications[0].medications[0].name,
      medications[0].medications[0].dosage_instruction[0].text,
      medications[0].clinical_notes,
      medications[0].notes,
    ];
    for (const value of promotedFields) {
      expect(value).not.toMatch(/[<>]/);
      expect(value).not.toMatch(/javascript\s*:|onerror\s*=/i);
    }
    expect(medications[0].medication_name).toContain('Metformin');
    expect(medications[0].medication_name).toContain('500 mg');
    expect(medications[0].medications[0].dosage_instruction[0].text)
      .toContain('One tablet daily');
    expect(medications[0].notes).toContain('External medication note');
  });
});
