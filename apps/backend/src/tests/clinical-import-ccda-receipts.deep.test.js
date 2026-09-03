// Migration 755 journey proof for governed manual C-CDA import. Receipt and
// canonical evidence must commit with longitudinal medication history, exact
// replay must be effect-free, and recordTarget identity drift must fail before
// any receipt is persisted.
//
// The receipt ledger is append-only, so this suite uses unique fixture
// identities and intentionally leaves its evidence in the ephemeral CI DB.

import crypto from 'node:crypto';

import { jest } from '@jest/globals';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { importCCDA } from '../services/import/patientDataImport.js';
import { clinicalImportSha256 } from '../services/import/clinicalImportReceiptService.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT_ID = crypto.randomUUID();
const PATIENT_UID = crypto.randomUUID();
const IMPORTER_UID = crypto.randomUUID();
const FOREIGN_PATIENT_UID = crypto.randomUUID();
const FIXTURE_SUFFIX = TENANT_ID.slice(0, 8);
const PATIENT_PHONE = `8${crypto.randomInt(100_000_000, 1_000_000_000)}`;
const IMPORTER_PHONE = `7${crypto.randomInt(100_000_000, 1_000_000_000)}`;
const SOURCE_DOCUMENT_ID = `ccda-receipt-${FIXTURE_SUFFIX}`;
const IDEMPOTENCY_KEY = `ccda-receipt-idempotency-${TENANT_ID}`;
const AUTHORITY_GRANT_ID = crypto.randomUUID();
const ACCESS_POLICY = Object.freeze({
  access_decision: 'allow',
  access_source: 'test_fixture_explicit_grant',
  policy_code: 'patient.record.upload',
  policy_version: '1',
  policy_hash: clinicalImportSha256('test-manual-clinical-import-policy-v1'),
  reason: 'Explicit test-only clinical import access evidence',
});

let patientId;
let facilityId;

async function query(sql, ...params) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

function ccdaDocument({ patientUid = PATIENT_UID, medicationName = 'Metformin 500 mg tablet' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5" extension="${SOURCE_DOCUMENT_ID}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <title>Clinical import receipt journey</title>
  <effectiveTime value="20260831120000+0530"/>
  <author>
    <time value="20260831115500+0530"/>
    <assignedAuthor>
      <id root="urn:vhhealth:user:uid" extension="${IMPORTER_UID}"/>
      <assignedPerson><name><given>Receipt</given><family>Importer</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <recordTarget>
    <patientRole>
      <id root="urn:vhhealth:uid" extension="${patientUid}"/>
      <telecom value="tel:${PATIENT_PHONE}" use="MC"/>
      <addr>
        <streetAddressLine>Receipt Test Street</streetAddressLine>
        <city>Kochi</city>
        <state>Kerala</state>
        <postalCode>682001</postalCode>
      </addr>
      <patient>
        <name use="L"><given>Receipt</given><family>Patient</family></name>
        <administrativeGenderCode code="F"/>
        <birthTime value="19880312"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
          <code code="10160-0" codeSystem="2.16.840.1.113883.6.1" displayName="History of Medication Use"/>
          <title>Medications</title>
          <text>${medicationName}</text>
          <entry>
            <substanceAdministration classCode="SBADM" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
              <statusCode code="active"/>
              <effectiveTime xsi:type="IVL_TS"><low value="20260115"/></effectiveTime>
              <consumable>
                <manufacturedProduct classCode="MANU">
                  <manufacturedMaterial>
                    <code code="860975" codeSystem="2.16.840.1.113883.6.88" displayName="${medicationName}">
                      <originalText>${medicationName}</originalText>
                    </code>
                  </manufacturedMaterial>
                </manufacturedProduct>
              </consumable>
            </substanceAdministration>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

function authorityFor(xml, {
  sourceDocumentId = SOURCE_DOCUMENT_ID,
  idempotencyKey = IDEMPOTENCY_KEY,
} = {}) {
  const sourcePayloadSha256 = clinicalImportSha256(xml);
  return {
    patientUid: PATIENT_UID,
    patientId,
    sourceSystem: 'jest-clinical-import-ccda-receipts',
    sourceDocumentId,
    sourceFacilityId: facilityId,
    authorityGrantId: AUTHORITY_GRANT_ID,
    sourceSignatureSha256: clinicalImportSha256(`signature:${sourcePayloadSha256}`),
    sourcePayloadSha256,
    rawDocument: Buffer.from(xml, 'utf8'),
    rawContentType: 'application/xml',
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
    authority_grant_id: AUTHORITY_GRANT_ID,
    patient_uid: PATIENT_UID,
    source_facility_id: facilityId,
    actor_uid: IMPORTER_UID,
    source_system: authority.sourceSystem,
    source_document_id: authority.sourceDocumentId,
    document_format: 'ccda',
    raw_payload_sha256: crypto.createHash('sha256').update(authority.rawDocument).digest('hex'),
    raw_payload_bytes: authority.rawDocument.length,
    raw_content_type: 'application/xml',
    canonicalization_version: 'exact-http-body+ccda-xml-v1',
    canonical_payload_sha256: authority.sourcePayloadSha256,
    signature_verification_status: 'asserted_unverified',
  });
  expect(rows[0].raw_artifact_id).toEqual(expect.any(String));
  expect(rows[0].access_decision_evidence).toMatchObject({
    contract_version: 'clinical-import-access-decision-v1',
    decision: 'allow',
    authority_grant_id: AUTHORITY_GRANT_ID,
    patient_uid: PATIENT_UID,
    patient_access: ACCESS_POLICY,
  });
  expect(rows[0].source_author_evidence.authors).toEqual([
    expect.objectContaining({
      source: 'ClinicalDocument.author.assignedAuthor',
      identifier_system: 'urn:vhhealth:user:uid',
      identifier_value: IMPORTER_UID,
    }),
  ]);
  expect(rows[0].raw_source_author_evidence).toEqual(rows[0].source_author_evidence);
}

d('migration 755 C-CDA clinical import receipt journey (real PostgreSQL)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())`,
      TENANT_ID,
      `clinical-import-ccda-${FIXTURE_SUFFIX}`,
      `Clinical Import C-CDA ${FIXTURE_SUFFIX}`,
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
        `C-CDA Receipt Patient ${FIXTURE_SUFFIX}`,
        `C-CDA Receipt Importer ${FIXTURE_SUFFIX}`,
      );
      patientId = Number(users.find((row) => String(row.uid) === PATIENT_UID).id);

      const facilities = await tx.$queryRawUnsafe(
        `INSERT INTO facilities
           (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, $2, $3, 'active', FALSE)
         RETURNING id`,
        TENANT_ID,
        `CCDA-${FIXTURE_SUFFIX}`,
        `C-CDA Import Facility ${FIXTURE_SUFFIX}`,
      );
      facilityId = Number(facilities[0].id);

      const ownerEvidenceRef = `test://clinical-import/ccda/${AUTHORITY_GRANT_ID}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_import_authority_events
           (tenant_id, grant_id, event_type, patient_uid, facility_id,
            actor_uid, actor_role, source_system, document_formats,
            valid_from, valid_until, owner_evidence_ref, owner_evidence_sha256,
            recorded_by, reason, idempotency_key_sha256, contract_version)
         VALUES
           ($1::uuid, $2::uuid, 'GRANTED', $3::uuid, $4::int,
            $5::uuid, 'MEDICAL_RECORDS', 'jest-clinical-import-ccda-receipts',
            ARRAY['ccda']::text[], NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 day',
            $6, $7, $5::uuid, $8, $9, 1)`,
        TENANT_ID,
        AUTHORITY_GRANT_ID,
        PATIENT_UID,
        facilityId,
        IMPORTER_UID,
        ownerEvidenceRef,
        clinicalImportSha256(ownerEvidenceRef),
        'Explicit test grant for C-CDA receipt import',
        clinicalImportSha256(`grant:${TENANT_ID}:${AUTHORITY_GRANT_ID}`),
      );
    });
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('persists receipt-bound C-CDA history, replays exactly, and rejects identity or ledger mutation', async () => {
    const xml = ccdaDocument();
    const authority = authorityFor(xml);

    const first = await importCCDA(xml, IMPORTER_UID, {
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
      `SELECT id, patient_id, patient_uid, source_facility_id, actor_uid,
              actor_role, ingestion_mode, document_format, source_system,
              source_document_id, source_payload_sha256, source_identity_sha256,
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
      source_facility_id: facilityId,
      actor_uid: IMPORTER_UID,
      actor_role: 'MEDICAL_RECORDS',
      ingestion_mode: 'manual_medical_records',
      document_format: 'ccda',
      source_system: 'jest-clinical-import-ccda-receipts',
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
      source_resource_type: 'C-CDA_Patient',
      source_resource_id: null,
      source_resource_index: 0,
      outcome: 'deduplicated',
      target_table: 'users',
      target_id: String(patientId),
      canonical_timeline_event_id: null,
      canonical_audit_event_id: null,
    });
    expect(resources[1]).toMatchObject({
      source_resource_type: 'C-CDA_Medication',
      source_resource_id: '860975',
      source_resource_index: 1,
      outcome: 'imported',
      target_table: 'e_prescriptions',
    });
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
    expect(medications[0].medications[0]).toMatchObject({
      source: 'C-CDA_Medication',
      source_code: '860975',
      source_status: 'active',
      effective_start: '2026-01-15',
      timing_unresolved: true,
    });
    expect(medications[0].medications[0].import_receipt).toMatchObject({
      source_resource_type: 'C-CDA_Medication',
      source_resource_index: resources[1].source_resource_index,
      document_source_identity_sha256: documents[0].source_identity_sha256,
      resource_manifest_sha256: documents[0].resource_manifest_sha256,
      idempotency_key_sha256: clinicalImportSha256(IDEMPOTENCY_KEY),
    });
    expect(medications[0].medications[0].import_receipt).not.toHaveProperty('idempotency_key');

    const documentTimeline = await query(
      `SELECT event_type, source_table, source_id, actor_uid
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
      `SELECT action, resource_table, resource_id, actor_uid
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
      `SELECT event_type, source_table, source_id, actor_uid
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
      `SELECT action, resource_table, resource_id, actor_uid
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

    const replay = await importCCDA(xml, IMPORTER_UID, {
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

    const mismatchedXml = ccdaDocument({ patientUid: FOREIGN_PATIENT_UID });
    const mismatchedSourceDocumentId = `${SOURCE_DOCUMENT_ID}-foreign-patient`;
    const mismatchedAuthority = authorityFor(mismatchedXml, {
      sourceDocumentId: mismatchedSourceDocumentId,
      idempotencyKey: `${IDEMPOTENCY_KEY}-foreign-patient`,
    });
    await expect(importCCDA(mismatchedXml, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: mismatchedAuthority,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_PATIENT_IDENTITY_MISMATCH',
    });
    const mismatchReceipts = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM clinical_import_document_receipts
           WHERE tenant_id=$1::uuid AND source_document_id=$2) AS document_count,
         (SELECT COUNT(*)::int FROM clinical_import_raw_artifacts
           WHERE tenant_id=$1::uuid AND source_document_id=$2) AS raw_artifact_count,
         (SELECT COUNT(*)::int FROM clinical_import_reconciliation_items
           WHERE tenant_id=$1::uuid) AS reconciliation_item_count,
         (SELECT COUNT(*)::int FROM clinical_import_reconciliation_events
           WHERE tenant_id=$1::uuid) AS reconciliation_event_count`,
      TENANT_ID,
      mismatchedSourceDocumentId,
    );
    expect(mismatchReceipts).toEqual([{
      document_count: 0,
      raw_artifact_count: 0,
      reconciliation_item_count: 0,
      reconciliation_event_count: 0,
    }]);

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
  });
});
