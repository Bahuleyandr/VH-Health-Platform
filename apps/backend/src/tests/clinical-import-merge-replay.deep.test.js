// Migration 755 and patient-merge journey proof: immutable import custody
// stays on the source patient identity while the operational medication chart
// follows the merge survivor. Exact replay is accepted only for that merged
// family; an unrelated patient or changed source contract fails closed.
//
// Receipt rows are append-only, so this suite leaves its unique fixture tenant
// in the ephemeral CI database instead of inventing a cleanup bypass.

import crypto from 'node:crypto';

import { jest } from '@jest/globals';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  approveMerge,
  executeMerge,
  requestMerge,
} from '../services/patient/patientMergeService.js';
import { importCCDA, importFhirBundle } from '../services/import/patientDataImport.js';
import { clinicalImportSha256 } from '../services/import/clinicalImportReceiptService.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;
jest.setTimeout(60_000);

const TENANT_ID = crypto.randomUUID();
const PATIENT_A_UID = crypto.randomUUID();
const PATIENT_B_UID = crypto.randomUUID();
const PATIENT_C_UID = crypto.randomUUID();
const CCDA_PATIENT_A_UID = crypto.randomUUID();
const CCDA_PATIENT_B_UID = crypto.randomUUID();
const CCDA_PATIENT_C_UID = crypto.randomUUID();
const REQUESTER_UID = crypto.randomUUID();
const APPROVER_UID = crypto.randomUUID();
const EXECUTOR_UID = crypto.randomUUID();
const IMPORTER_UID = crypto.randomUUID();
const MEDICATION_RESOURCE_ID = crypto.randomUUID();
const SUFFIX = TENANT_ID.slice(0, 8);
const SOURCE_DOCUMENT_ID = `merge-replay-fhir-${SUFFIX}`;
const IDEMPOTENCY_KEY = `merge-replay-idempotency-${TENANT_ID}`;
const CCDA_SOURCE_DOCUMENT_ID = `merge-replay-ccda-${SUFFIX}`;
const CCDA_IDEMPOTENCY_KEY = `merge-replay-ccda-idempotency-${TENANT_ID}`;

const patientIds = new Map();
let facilityId;
let fhirAuthorityGrant;
let ccdaAuthorityGrant;

function phone(index) {
  return `6${crypto.randomInt(100_000_000, 1_000_000_000) - index}`;
}

const PATIENT_B_PHONE = phone(2);
const CCDA_PATIENT_B_PHONE = phone(9);

async function seedClinicalImportAuthorityGrant(tx, {
  patientUid,
  documentFormat,
  sourceSystem,
}) {
  const grantId = crypto.randomUUID();
  const ownerEvidenceRef = `urn:vhhealth:test:clinical-import-owner:${grantId}`;
  const ownerEvidenceSha256 = clinicalImportSha256({
    contract_version: 1,
    grant_id: grantId,
    patient_uid: patientUid,
    facility_id: facilityId,
    actor_uid: IMPORTER_UID,
    source_system: sourceSystem,
    document_format: documentFormat,
    owner_evidence_ref: ownerEvidenceRef,
  });
  await tx.$executeRawUnsafe(
    `INSERT INTO clinical_import_authority_events
       (tenant_id, grant_id, event_type, patient_uid, facility_id,
        actor_uid, actor_role, source_system, document_formats,
        valid_from, valid_until, owner_evidence_ref, owner_evidence_sha256,
        recorded_by, reason, idempotency_key_sha256, contract_version)
     VALUES
       ($1::uuid, $2::uuid, 'GRANTED', $3::uuid, $4::int,
        $5::uuid, 'MEDICAL_RECORDS', $6, ARRAY[$7]::text[],
        NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 hour', $8, $9,
        $5::uuid, $10, $11, 1)`,
    TENANT_ID,
    grantId,
    patientUid,
    facilityId,
    IMPORTER_UID,
    sourceSystem,
    documentFormat,
    ownerEvidenceRef,
    ownerEvidenceSha256,
    'Real-PostgreSQL clinical import merge and replay authority fixture',
    clinicalImportSha256(`authority-grant:${grantId}`),
  );
  return { grantId, ownerEvidenceSha256 };
}

function patientIdentityBinding(patientUid, patientId) {
  const patientIdentifierIds = [];
  return {
    patientIdentifierIds,
    patientIdentityBindingSha256: clinicalImportSha256(
      `clinical-import-patient-identity-v1|${TENANT_ID}|${patientId}`
      + `|${patientUid}|${patientIdentifierIds.join(',')}`,
    ),
  };
}

function accessDecisionEvidence({
  patientUid,
  sourceDocumentId,
  sourceSystem,
  documentFormat,
  authorityGrant,
  patientIdentityBindingSha256,
}) {
  const policy = {
    policy_code: 'patient.record.upload',
    policy_version: 'clinical-import-merge-replay-v1',
    patient_uid: patientUid,
    source_document_id: sourceDocumentId,
  };
  return {
    contract_version: 'clinical-import-access-decision-v1',
    decision: 'allow',
    authority_grant_id: authorityGrant.grantId,
    patient_uid: patientUid,
    actor_uid: IMPORTER_UID,
    source_facility_id: String(facilityId),
    source_system: sourceSystem,
    document_format: documentFormat,
    patient_identity_binding_sha256: patientIdentityBindingSha256,
    owner_evidence_sha256: authorityGrant.ownerEvidenceSha256,
    access_source: 'policy',
    ...policy,
    policy_hash: clinicalImportSha256(policy),
    reason: 'isolated PostgreSQL journey authority fixture',
  };
}

async function query(sql, ...params) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

function fhirBundle({ medicationName = 'Amlodipine 5 mg tablet' } = {}) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        fullUrl: `urn:uuid:${PATIENT_B_UID}`,
        resource: {
          resourceType: 'Patient',
          id: PATIENT_B_UID,
          identifier: [{ system: 'urn:vhhealth:uid', value: PATIENT_B_UID }],
          active: true,
          name: [{ use: 'official', text: `Merge source B ${SUFFIX}` }],
          telecom: [{ system: 'phone', value: PATIENT_B_PHONE, use: 'mobile' }],
        },
      },
      {
        fullUrl: `urn:uuid:${MEDICATION_RESOURCE_ID}`,
        resource: {
          resourceType: 'MedicationRequest',
          id: MEDICATION_RESOURCE_ID,
          status: 'active',
          intent: 'order',
          subject: { reference: `Patient/${PATIENT_B_UID}` },
          authoredOn: '2026-09-01',
          medicationCodeableConcept: {
            coding: [{
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
              code: '197361',
              display: medicationName,
            }],
            text: medicationName,
          },
          dosageInstruction: [{ text: 'One tablet once daily' }],
          note: [{ text: 'Imported before duplicate-patient merge' }],
          requester: {
            identifier: {
              system: 'urn:vhhealth:source-author',
              value: `fhir-author-${SUFFIX}`,
            },
            display: `FHIR Source Author ${SUFFIX}`,
          },
        },
      },
    ],
  };
}

function authorityFor(bundle, {
  patientUid,
  patientId,
  idempotencyKey = IDEMPOTENCY_KEY,
  authorityGrant = fhirAuthorityGrant,
} = {}) {
  const sourcePayloadSha256 = clinicalImportSha256(bundle);
  const identityBinding = patientIdentityBinding(patientUid, patientId);
  const decisionEvidence = accessDecisionEvidence({
    patientUid,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceSystem: 'jest-clinical-import-merge-replay',
    documentFormat: 'fhir_bundle',
    authorityGrant,
    patientIdentityBindingSha256: identityBinding.patientIdentityBindingSha256,
  });
  return {
    patientUid,
    patientId,
    sourceSystem: 'jest-clinical-import-merge-replay',
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceFacilityId: facilityId,
    authorityGrantId: authorityGrant.grantId,
    sourceSignatureSha256: clinicalImportSha256(`signature:${sourcePayloadSha256}`),
    sourcePayloadSha256,
    idempotencyKey,
    actorUid: IMPORTER_UID,
    actorRole: 'MEDICAL_RECORDS',
    ingestionMode: 'manual_medical_records',
    requestId: crypto.randomUUID(),
    rawDocument: Buffer.from(JSON.stringify(bundle), 'utf8'),
    rawContentType: 'application/fhir+json',
    ...identityBinding,
    accessDecisionEvidence: decisionEvidence,
    revalidateAccess: async () => decisionEvidence,
  };
}

function ccdaDocument({ medicationName = 'Losartan 50 mg tablet' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5" extension="${CCDA_SOURCE_DOCUMENT_ID}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <title>Clinical import merge replay</title>
  <effectiveTime value="20260901120000+0530"/>
  <author>
    <time value="20260901120000+0530"/>
    <assignedAuthor>
      <id root="2.16.840.1.113883.4.6" extension="CCDA-AUTHOR-${SUFFIX}"/>
      <assignedPerson><name><given>Source</given><family>Author</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <recordTarget>
    <patientRole>
      <id root="urn:vhhealth:uid" extension="${CCDA_PATIENT_B_UID}"/>
      <telecom value="tel:${CCDA_PATIENT_B_PHONE}" use="MC"/>
      <addr>
        <streetAddressLine>Merge Replay Street</streetAddressLine>
        <city>Kochi</city><state>Kerala</state><postalCode>682001</postalCode>
      </addr>
      <patient>
        <name use="L"><given>Merge</given><family>Source</family></name>
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
              <effectiveTime xsi:type="IVL_TS"><low value="20260201"/></effectiveTime>
              <consumable>
                <manufacturedProduct classCode="MANU">
                  <manufacturedMaterial>
                    <code code="979492" codeSystem="2.16.840.1.113883.6.88" displayName="${medicationName}">
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

function ccdaAuthorityFor(xml, {
  patientUid,
  patientId,
  idempotencyKey = CCDA_IDEMPOTENCY_KEY,
  authorityGrant = ccdaAuthorityGrant,
} = {}) {
  const sourcePayloadSha256 = clinicalImportSha256(xml);
  const identityBinding = patientIdentityBinding(patientUid, patientId);
  const decisionEvidence = accessDecisionEvidence({
    patientUid,
    sourceDocumentId: CCDA_SOURCE_DOCUMENT_ID,
    sourceSystem: 'jest-clinical-import-merge-replay-ccda',
    documentFormat: 'ccda',
    authorityGrant,
    patientIdentityBindingSha256: identityBinding.patientIdentityBindingSha256,
  });
  return {
    patientUid,
    patientId,
    sourceSystem: 'jest-clinical-import-merge-replay-ccda',
    sourceDocumentId: CCDA_SOURCE_DOCUMENT_ID,
    sourceFacilityId: facilityId,
    authorityGrantId: authorityGrant.grantId,
    sourceSignatureSha256: clinicalImportSha256(`signature:${sourcePayloadSha256}`),
    sourcePayloadSha256,
    idempotencyKey,
    actorUid: IMPORTER_UID,
    actorRole: 'MEDICAL_RECORDS',
    ingestionMode: 'manual_medical_records',
    requestId: crypto.randomUUID(),
    rawDocument: Buffer.from(xml, 'utf8'),
    rawContentType: 'application/xml',
    ...identityBinding,
    accessDecisionEvidence: decisionEvidence,
    revalidateAccess: async () => decisionEvidence,
  };
}

async function receiptSnapshot(receiptId) {
  const documents = await query(
    `SELECT id::text AS id, patient_id, patient_uid::text AS patient_uid,
            document_format, authority_grant_id::text AS authority_grant_id,
            raw_artifact_id::text AS raw_artifact_id, patient_identifier_ids,
            patient_identity_binding_sha256, access_decision_evidence,
            source_author_evidence,
            canonical_timeline_event_id::text AS canonical_timeline_event_id,
            canonical_audit_event_id::text AS canonical_audit_event_id,
            source_identity_sha256, idempotency_key_sha256,
            resource_manifest_sha256, result
       FROM clinical_import_document_receipts
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    TENANT_ID,
    receiptId,
  );
  const resources = await query(
    `SELECT id::text AS id, document_receipt_id::text AS document_receipt_id,
            patient_uid::text AS patient_uid, source_resource_type,
            source_resource_id, source_resource_index, outcome, target_table,
            target_id, canonical_timeline_event_id::text AS canonical_timeline_event_id,
            canonical_audit_event_id::text AS canonical_audit_event_id
       FROM clinical_import_resource_receipts
      WHERE tenant_id=$1::uuid AND document_receipt_id=$2::uuid
      ORDER BY source_resource_index`,
    TENANT_ID,
    receiptId,
  );
  return { documents, resources };
}

async function rawArtifactSnapshot(rawArtifactId) {
  return query(
    `SELECT id::text AS id, authority_grant_id::text AS authority_grant_id,
            patient_uid::text AS patient_uid, source_facility_id,
            actor_uid::text AS actor_uid, actor_role, source_system,
            source_document_id, document_format, raw_payload_sha256,
            raw_payload_bytes::int AS raw_payload_bytes, raw_content_type,
            raw_payload_ciphertext, canonicalization_version, canonical_payload_sha256,
            asserted_source_signature_sha256, signature_verification_status,
            source_author_evidence
       FROM clinical_import_raw_artifacts
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    TENANT_ID,
    rawArtifactId,
  );
}

async function authorityGrantSnapshot(grantId) {
  return query(
    `SELECT grant_id::text AS grant_id, event_type,
            patient_uid::text AS patient_uid, facility_id,
            actor_uid::text AS actor_uid, actor_role, source_system,
            document_formats, owner_evidence_ref, owner_evidence_sha256,
            recorded_by::text AS recorded_by, contract_version
       FROM clinical_import_authority_events
      WHERE tenant_id=$1::uuid AND grant_id=$2::uuid
      ORDER BY created_at, id`,
    TENANT_ID,
    grantId,
  );
}

async function tenantCounts() {
  return query(
    `SELECT
       (SELECT COUNT(*)::int FROM clinical_import_document_receipts
         WHERE tenant_id=$1::uuid) AS document_count,
       (SELECT COUNT(*)::int FROM clinical_import_resource_receipts
          WHERE tenant_id=$1::uuid) AS resource_count,
       (SELECT COUNT(*)::int FROM clinical_import_raw_artifacts
          WHERE tenant_id=$1::uuid) AS raw_artifact_count,
       (SELECT COUNT(*)::int FROM clinical_import_authority_events
          WHERE tenant_id=$1::uuid) AS authority_event_count,
       (SELECT COUNT(*)::int FROM e_prescriptions
         WHERE tenant_id=$1::uuid) AS prescription_count,
       (SELECT COUNT(*)::int FROM clinical_timeline_events
         WHERE tenant_id=$1::uuid) AS timeline_count,
       (SELECT COUNT(*)::int FROM clinical_audit_events
         WHERE tenant_id=$1::uuid) AS audit_count`,
    TENANT_ID,
  );
}

d('clinical import replay across a production patient merge (real PostgreSQL)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())`,
      TENANT_ID,
      `clinical-import-merge-${SUFFIX}`,
      `Clinical Import Merge ${SUFFIX}`,
    );

    await setTenantTx(TENANT_ID, async (tx) => {
      const users = await tx.$queryRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, name, role, is_active, status, is_deleted, updated_at)
         VALUES
           ($1::uuid, $8::uuid, $9,  $16, 'PATIENT',         TRUE, 'active', FALSE, NOW()),
           ($2::uuid, $8::uuid, $10, $17, 'PATIENT',         TRUE, 'active', FALSE, NOW()),
           ($3::uuid, $8::uuid, $11, $18, 'PATIENT',         TRUE, 'active', FALSE, NOW()),
           ($4::uuid, $8::uuid, $12, $19, 'STAFF',           TRUE, 'active', FALSE, NOW()),
           ($5::uuid, $8::uuid, $13, $20, 'STAFF',           TRUE, 'active', FALSE, NOW()),
           ($6::uuid, $8::uuid, $14, $21, 'STAFF',           TRUE, 'active', FALSE, NOW()),
           ($7::uuid, $8::uuid, $15, $22, 'MEDICAL_RECORDS', TRUE, 'active', FALSE, NOW())
         RETURNING id, uid::text AS uid`,
        PATIENT_A_UID,
        PATIENT_B_UID,
        PATIENT_C_UID,
        REQUESTER_UID,
        APPROVER_UID,
        EXECUTOR_UID,
        IMPORTER_UID,
        TENANT_ID,
        phone(1),
        PATIENT_B_PHONE,
        phone(3),
        phone(4),
        phone(5),
        phone(6),
        phone(7),
        `Merge survivor A ${SUFFIX}`,
        `Merge source B ${SUFFIX}`,
        `Unrelated C ${SUFFIX}`,
        `Merge requester ${SUFFIX}`,
        `Merge approver ${SUFFIX}`,
        `Merge executor ${SUFFIX}`,
        `Clinical importer ${SUFFIX}`,
      );
      for (const user of users) patientIds.set(user.uid, Number(user.id));

      const ccdaPatients = await tx.$queryRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, name, role, is_active, status, is_deleted, updated_at)
         VALUES
           ($1::uuid, $4::uuid, $5, $8,  'PATIENT', TRUE, 'active', FALSE, NOW()),
           ($2::uuid, $4::uuid, $6, $9,  'PATIENT', TRUE, 'active', FALSE, NOW()),
           ($3::uuid, $4::uuid, $7, $10, 'PATIENT', TRUE, 'active', FALSE, NOW())
         RETURNING id, uid::text AS uid`,
        CCDA_PATIENT_A_UID,
        CCDA_PATIENT_B_UID,
        CCDA_PATIENT_C_UID,
        TENANT_ID,
        phone(8),
        CCDA_PATIENT_B_PHONE,
        phone(10),
        `C-CDA merge survivor A ${SUFFIX}`,
        `C-CDA merge source B ${SUFFIX}`,
        `C-CDA unrelated C ${SUFFIX}`,
      );
      for (const user of ccdaPatients) patientIds.set(user.uid, Number(user.id));

      const facilities = await tx.$queryRawUnsafe(
        `INSERT INTO facilities
           (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, $2, $3, 'active', FALSE)
         RETURNING id`,
        TENANT_ID,
        `MRG-${SUFFIX}`,
        `Merge Import Facility ${SUFFIX}`,
      );
      facilityId = Number(facilities[0].id);
      fhirAuthorityGrant = await seedClinicalImportAuthorityGrant(tx, {
        patientUid: PATIENT_B_UID,
        documentFormat: 'fhir_bundle',
        sourceSystem: 'jest-clinical-import-merge-replay',
      });
      ccdaAuthorityGrant = await seedClinicalImportAuthorityGrant(tx, {
        patientUid: CCDA_PATIENT_B_UID,
        documentFormat: 'ccda',
        sourceSystem: 'jest-clinical-import-merge-replay-ccda',
      });
    });
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('keeps receipt custody on B, moves operational history to A, and limits replay to the merged family', async () => {
    const bundle = fhirBundle();
    const originalAuthority = authorityFor(bundle, {
      patientUid: PATIENT_B_UID,
      patientId: patientIds.get(PATIENT_B_UID),
    });
    const imported = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: originalAuthority,
    });
    expect(imported).toMatchObject({
      imported: 1,
      deduplicated: 1,
      skipped: 0,
      errors: [],
      replayed: false,
    });
    expect(imported.receipt_id).toEqual(expect.any(String));

    const beforeMerge = await receiptSnapshot(imported.receipt_id);
    expect(beforeMerge.documents).toHaveLength(1);
    expect(beforeMerge.documents[0]).toMatchObject({
      patient_id: patientIds.get(PATIENT_B_UID),
      patient_uid: PATIENT_B_UID,
      authority_grant_id: fhirAuthorityGrant.grantId,
      patient_identity_binding_sha256: originalAuthority.patientIdentityBindingSha256,
    });
    const fhirRawArtifact = await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id);
    expect(fhirRawArtifact).toEqual([expect.objectContaining({
      authority_grant_id: fhirAuthorityGrant.grantId,
      patient_uid: PATIENT_B_UID,
      source_facility_id: facilityId,
      actor_uid: IMPORTER_UID,
      actor_role: 'MEDICAL_RECORDS',
      source_system: 'jest-clinical-import-merge-replay',
      source_document_id: SOURCE_DOCUMENT_ID,
      document_format: 'fhir_bundle',
      raw_payload_sha256: crypto.createHash('sha256')
        .update(originalAuthority.rawDocument).digest('hex'),
      raw_payload_bytes: originalAuthority.rawDocument.length,
      raw_content_type: 'application/fhir+json',
      canonicalization_version: 'exact-http-body+fhir-canonical-json-v1',
      canonical_payload_sha256: originalAuthority.sourcePayloadSha256,
      asserted_source_signature_sha256: originalAuthority.sourceSignatureSha256,
      signature_verification_status: 'asserted_unverified',
    })]);
    expect(beforeMerge.resources).toHaveLength(2);
    expect(beforeMerge.resources[1]).toMatchObject({
      patient_uid: PATIENT_B_UID,
      source_resource_type: 'MedicationRequest',
      outcome: 'imported',
      target_table: 'e_prescriptions',
    });
    const medicationId = beforeMerge.resources[1].target_id;

    const requested = await requestMerge({
      tenantId: TENANT_ID,
      primaryUid: PATIENT_A_UID,
      secondaryUid: PATIENT_B_UID,
      requestedBy: REQUESTER_UID,
      requesterNote: `Clinical import merge replay ${SUFFIX}`,
    });
    await approveMerge({
      tenantId: TENANT_ID,
      id: requested.id,
      approverUid: APPROVER_UID,
      approverNote: 'Independent duplicate-patient review complete',
    });
    const merged = await executeMerge({
      tenantId: TENANT_ID,
      id: requested.id,
      executorUid: EXECUTOR_UID,
    });
    expect(merged.status).toBe('executed');

    const skipped = merged.execution_summary.update_blocked_skipped;
    expect(skipped).toEqual(expect.arrayContaining([
      'clinical_import_document_receipts.patient_id',
      'clinical_import_document_receipts.patient_uid',
      'clinical_import_resource_receipts.patient_uid',
    ]));
    expect(merged.execution_summary.update_blocked_triggers).toMatchObject({
      clinical_import_document_receipts: expect.arrayContaining([
        'clinical_import_receipt_append_only_755',
      ]),
      clinical_import_resource_receipts: expect.arrayContaining([
        'clinical_import_receipt_append_only_755',
      ]),
    });

    const afterMerge = await receiptSnapshot(imported.receipt_id);
    expect(afterMerge).toEqual(beforeMerge);
    expect(await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id))
      .toEqual(fhirRawArtifact);

    const medication = await query(
      `SELECT id::text AS id, patient_id, patient_uid::text AS patient_uid,
              lifecycle_status, medications
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      medicationId,
    );
    expect(medication).toHaveLength(1);
    expect(medication[0]).toMatchObject({
      id: medicationId,
      patient_id: patientIds.get(PATIENT_A_UID),
      patient_uid: PATIENT_A_UID,
      lifecycle_status: 'imported_history',
    });
    expect(medication[0].medications[0].import_receipt).toMatchObject({
      source_resource_id: MEDICATION_RESOURCE_ID,
      document_source_identity_sha256: beforeMerge.documents[0].source_identity_sha256,
      resource_manifest_sha256: beforeMerge.documents[0].resource_manifest_sha256,
      idempotency_key_sha256: clinicalImportSha256(IDEMPOTENCY_KEY),
    });
    expect(merged.execution_summary.table_summary.e_prescriptions).toMatchObject({
      rows_moved: 2,
      fk_columns: expect.arrayContaining(['patient_id', 'patient_uid']),
    });

    const canonicalIds = [
      beforeMerge.documents[0].canonical_timeline_event_id,
      beforeMerge.resources[1].canonical_timeline_event_id,
    ];
    const auditIds = [
      beforeMerge.documents[0].canonical_audit_event_id,
      beforeMerge.resources[1].canonical_audit_event_id,
    ];
    const canonicalEvidence = await query(
      `SELECT id::text AS id, patient_uid::text AS patient_uid
         FROM clinical_timeline_events
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])
        ORDER BY id`,
      TENANT_ID,
      canonicalIds,
    );
    const auditEvidence = await query(
      `SELECT id::text AS id, patient_uid::text AS patient_uid
         FROM clinical_audit_events
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])
        ORDER BY id`,
      TENANT_ID,
      auditIds,
    );
    expect(canonicalEvidence).toHaveLength(2);
    expect(canonicalEvidence.every((row) => row.patient_uid === PATIENT_B_UID)).toBe(true);
    expect(auditEvidence).toHaveLength(2);
    expect(auditEvidence.every((row) => row.patient_uid === PATIENT_B_UID)).toBe(true);

    let survivorAuthorityGrant;
    let unrelatedAuthorityGrant;
    await setTenantTx(TENANT_ID, async (tx) => {
      survivorAuthorityGrant = await seedClinicalImportAuthorityGrant(tx, {
        patientUid: PATIENT_A_UID,
        documentFormat: 'fhir_bundle',
        sourceSystem: 'jest-clinical-import-merge-replay',
      });
      unrelatedAuthorityGrant = await seedClinicalImportAuthorityGrant(tx, {
        patientUid: PATIENT_C_UID,
        documentFormat: 'fhir_bundle',
        sourceSystem: 'jest-clinical-import-merge-replay',
      });
    });
    expect(await authorityGrantSnapshot(survivorAuthorityGrant.grantId))
      .toEqual([expect.objectContaining({
        grant_id: survivorAuthorityGrant.grantId,
        event_type: 'GRANTED',
        patient_uid: PATIENT_A_UID,
        facility_id: facilityId,
        actor_uid: IMPORTER_UID,
        actor_role: 'MEDICAL_RECORDS',
        source_system: 'jest-clinical-import-merge-replay',
        document_formats: ['fhir_bundle'],
        owner_evidence_sha256: survivorAuthorityGrant.ownerEvidenceSha256,
      })]);
    const beforeReplay = await tenantCounts();
    const survivorAuthority = authorityFor(bundle, {
      patientUid: PATIENT_A_UID,
      patientId: patientIds.get(PATIENT_A_UID),
      authorityGrant: survivorAuthorityGrant,
    });
    const replayed = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: survivorAuthority,
    });
    expect(replayed).toEqual({ ...imported, replayed: true });
    expect(await tenantCounts()).toEqual(beforeReplay);
    expect(await receiptSnapshot(imported.receipt_id)).toEqual(beforeMerge);
    expect(await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id))
      .toEqual(fhirRawArtifact);

    await expect(importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: authorityFor(bundle, {
        patientUid: PATIENT_C_UID,
        patientId: patientIds.get(PATIENT_C_UID),
        authorityGrant: unrelatedAuthorityGrant,
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    const changedBundle = fhirBundle({ medicationName: 'Amlodipine 10 mg tablet' });
    await expect(importFhirBundle(changedBundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: authorityFor(changedBundle, {
        patientUid: PATIENT_A_UID,
        patientId: patientIds.get(PATIENT_A_UID),
        authorityGrant: survivorAuthorityGrant,
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    await expect(importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: authorityFor(bundle, {
        patientUid: PATIENT_A_UID,
        patientId: patientIds.get(PATIENT_A_UID),
        idempotencyKey: `${IDEMPOTENCY_KEY}:changed`,
        authorityGrant: survivorAuthorityGrant,
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    expect(await tenantCounts()).toEqual(beforeReplay);
    expect(await receiptSnapshot(imported.receipt_id)).toEqual(beforeMerge);
  });

  it('keeps C-CDA receipt custody on B while the merged medication and exact replay follow A', async () => {
    const xml = ccdaDocument();
    const originalAuthority = ccdaAuthorityFor(xml, {
      patientUid: CCDA_PATIENT_B_UID,
      patientId: patientIds.get(CCDA_PATIENT_B_UID),
    });
    const imported = await importCCDA(xml, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: originalAuthority,
    });
    expect(imported).toMatchObject({
      imported: 1,
      deduplicated: 1,
      skipped: 0,
      errors: [],
      replayed: false,
    });
    expect(imported.receipt_id).toEqual(expect.any(String));

    const beforeMerge = await receiptSnapshot(imported.receipt_id);
    expect(beforeMerge.documents).toHaveLength(1);
    expect(beforeMerge.documents[0]).toMatchObject({
      patient_id: patientIds.get(CCDA_PATIENT_B_UID),
      patient_uid: CCDA_PATIENT_B_UID,
      document_format: 'ccda',
      authority_grant_id: ccdaAuthorityGrant.grantId,
      patient_identifier_ids: [],
      patient_identity_binding_sha256: originalAuthority.patientIdentityBindingSha256,
      idempotency_key_sha256: clinicalImportSha256(CCDA_IDEMPOTENCY_KEY),
    });
    expect(beforeMerge.documents[0].access_decision_evidence).toMatchObject({
      contract_version: 'clinical-import-access-decision-v1',
      decision: 'allow',
      authority_grant_id: ccdaAuthorityGrant.grantId,
      patient_uid: CCDA_PATIENT_B_UID,
      actor_uid: IMPORTER_UID,
      source_facility_id: String(facilityId),
      source_system: 'jest-clinical-import-merge-replay-ccda',
      document_format: 'ccda',
      patient_identity_binding_sha256: originalAuthority.patientIdentityBindingSha256,
      owner_evidence_sha256: ccdaAuthorityGrant.ownerEvidenceSha256,
    });
    expect(beforeMerge.documents[0].source_author_evidence).toMatchObject({
      assertion_status: 'asserted_from_source_unverified',
      authors: [expect.objectContaining({
        source: 'ClinicalDocument.author.assignedAuthor',
        display: 'Source Author',
        identifier_system: '2.16.840.1.113883.4.6',
        identifier_value: `CCDA-AUTHOR-${SUFFIX}`,
      })],
    });
    expect(beforeMerge.resources).toHaveLength(2);
    expect(beforeMerge.resources[1]).toMatchObject({
      patient_uid: CCDA_PATIENT_B_UID,
      source_resource_type: 'C-CDA_Medication',
      source_resource_id: '979492',
      outcome: 'imported',
      target_table: 'e_prescriptions',
    });
    const medicationId = beforeMerge.resources[1].target_id;
    const beforeGrant = await authorityGrantSnapshot(ccdaAuthorityGrant.grantId);
    expect(beforeGrant).toEqual([expect.objectContaining({
      grant_id: ccdaAuthorityGrant.grantId,
      event_type: 'GRANTED',
      patient_uid: CCDA_PATIENT_B_UID,
      facility_id: facilityId,
      actor_uid: IMPORTER_UID,
      actor_role: 'MEDICAL_RECORDS',
      source_system: 'jest-clinical-import-merge-replay-ccda',
      document_formats: ['ccda'],
      owner_evidence_sha256: ccdaAuthorityGrant.ownerEvidenceSha256,
      recorded_by: IMPORTER_UID,
      contract_version: 1,
    })]);
    const beforeRawArtifact = await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id);
    expect(beforeRawArtifact).toEqual([expect.objectContaining({
      id: beforeMerge.documents[0].raw_artifact_id,
      authority_grant_id: ccdaAuthorityGrant.grantId,
      patient_uid: CCDA_PATIENT_B_UID,
      source_facility_id: facilityId,
      actor_uid: IMPORTER_UID,
      actor_role: 'MEDICAL_RECORDS',
      source_system: 'jest-clinical-import-merge-replay-ccda',
      source_document_id: CCDA_SOURCE_DOCUMENT_ID,
      document_format: 'ccda',
      raw_payload_sha256: clinicalImportSha256(xml),
      raw_payload_bytes: Buffer.byteLength(xml, 'utf8'),
      raw_content_type: 'application/xml',
      canonicalization_version: 'exact-http-body+ccda-xml-v1',
      canonical_payload_sha256: originalAuthority.sourcePayloadSha256,
      asserted_source_signature_sha256: originalAuthority.sourceSignatureSha256,
      signature_verification_status: 'asserted_unverified',
      source_author_evidence: beforeMerge.documents[0].source_author_evidence,
    })]);
    expect(beforeRawArtifact[0].raw_payload_ciphertext).toMatch(/^enc:v2:/);
    expect(beforeRawArtifact[0].raw_payload_ciphertext).not.toContain('<ClinicalDocument');

    const requested = await requestMerge({
      tenantId: TENANT_ID,
      primaryUid: CCDA_PATIENT_A_UID,
      secondaryUid: CCDA_PATIENT_B_UID,
      requestedBy: REQUESTER_UID,
      requesterNote: `C-CDA clinical import merge replay ${SUFFIX}`,
    });
    await approveMerge({
      tenantId: TENANT_ID,
      id: requested.id,
      approverUid: APPROVER_UID,
      approverNote: 'Independent C-CDA duplicate-patient review complete',
    });
    const merged = await executeMerge({
      tenantId: TENANT_ID,
      id: requested.id,
      executorUid: EXECUTOR_UID,
    });
    expect(merged.status).toBe('executed');

    expect(merged.execution_summary.update_blocked_skipped).toEqual(expect.arrayContaining([
      'clinical_import_document_receipts.patient_id',
      'clinical_import_document_receipts.patient_uid',
      'clinical_import_resource_receipts.patient_uid',
    ]));
    expect(merged.execution_summary.update_blocked_triggers).toMatchObject({
      clinical_import_document_receipts: expect.arrayContaining([
        'clinical_import_receipt_append_only_755',
      ]),
      clinical_import_resource_receipts: expect.arrayContaining([
        'clinical_import_receipt_append_only_755',
      ]),
    });

    const afterMerge = await receiptSnapshot(imported.receipt_id);
    expect(afterMerge).toEqual(beforeMerge);
    expect(await authorityGrantSnapshot(ccdaAuthorityGrant.grantId)).toEqual(beforeGrant);
    expect(await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id))
      .toEqual(beforeRawArtifact);

    const medication = await query(
      `SELECT id::text AS id, patient_id, patient_uid::text AS patient_uid,
              lifecycle_status, medications
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      medicationId,
    );
    expect(medication).toHaveLength(1);
    expect(medication[0]).toMatchObject({
      id: medicationId,
      patient_id: patientIds.get(CCDA_PATIENT_A_UID),
      patient_uid: CCDA_PATIENT_A_UID,
      lifecycle_status: 'imported_history',
    });
    expect(medication[0].medications[0]).toMatchObject({
      source: 'C-CDA_Medication',
      source_code: '979492',
    });
    expect(medication[0].medications[0].import_receipt).toMatchObject({
      source_resource_type: 'C-CDA_Medication',
      source_resource_index: 0,
      document_source_identity_sha256: beforeMerge.documents[0].source_identity_sha256,
      resource_manifest_sha256: beforeMerge.documents[0].resource_manifest_sha256,
      idempotency_key_sha256: clinicalImportSha256(CCDA_IDEMPOTENCY_KEY),
    });
    expect(medication[0].medications[0].import_receipt).not.toHaveProperty('idempotency_key');
    expect(merged.execution_summary.table_summary.e_prescriptions).toMatchObject({
      rows_moved: 2,
      fk_columns: expect.arrayContaining(['patient_id', 'patient_uid']),
    });

    const canonicalIds = [
      beforeMerge.documents[0].canonical_timeline_event_id,
      beforeMerge.resources[1].canonical_timeline_event_id,
    ];
    const auditIds = [
      beforeMerge.documents[0].canonical_audit_event_id,
      beforeMerge.resources[1].canonical_audit_event_id,
    ];
    const canonicalEvidence = await query(
      `SELECT id::text AS id, patient_uid::text AS patient_uid
         FROM clinical_timeline_events
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])
        ORDER BY id`,
      TENANT_ID,
      canonicalIds,
    );
    const auditEvidence = await query(
      `SELECT id::text AS id, patient_uid::text AS patient_uid
         FROM clinical_audit_events
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])
        ORDER BY id`,
      TENANT_ID,
      auditIds,
    );
    expect(canonicalEvidence).toHaveLength(2);
    expect(canonicalEvidence.every((row) => row.patient_uid === CCDA_PATIENT_B_UID)).toBe(true);
    expect(auditEvidence).toHaveLength(2);
    expect(auditEvidence.every((row) => row.patient_uid === CCDA_PATIENT_B_UID)).toBe(true);

    let survivorAuthorityGrant;
    let unrelatedAuthorityGrant;
    await setTenantTx(TENANT_ID, async (tx) => {
      survivorAuthorityGrant = await seedClinicalImportAuthorityGrant(tx, {
        patientUid: CCDA_PATIENT_A_UID,
        documentFormat: 'ccda',
        sourceSystem: 'jest-clinical-import-merge-replay-ccda',
      });
      unrelatedAuthorityGrant = await seedClinicalImportAuthorityGrant(tx, {
        patientUid: CCDA_PATIENT_C_UID,
        documentFormat: 'ccda',
        sourceSystem: 'jest-clinical-import-merge-replay-ccda',
      });
    });
    expect(await authorityGrantSnapshot(survivorAuthorityGrant.grantId))
      .toEqual([expect.objectContaining({
        grant_id: survivorAuthorityGrant.grantId,
        event_type: 'GRANTED',
        patient_uid: CCDA_PATIENT_A_UID,
        facility_id: facilityId,
        actor_uid: IMPORTER_UID,
        actor_role: 'MEDICAL_RECORDS',
        source_system: 'jest-clinical-import-merge-replay-ccda',
        document_formats: ['ccda'],
        owner_evidence_sha256: survivorAuthorityGrant.ownerEvidenceSha256,
      })]);
    const beforeReplay = await tenantCounts();
    const survivorAuthority = ccdaAuthorityFor(xml, {
      patientUid: CCDA_PATIENT_A_UID,
      patientId: patientIds.get(CCDA_PATIENT_A_UID),
      authorityGrant: survivorAuthorityGrant,
    });
    const replayed = await importCCDA(xml, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: survivorAuthority,
    });
    expect(replayed).toEqual({ ...imported, replayed: true });
    expect(await tenantCounts()).toEqual(beforeReplay);
    expect(await receiptSnapshot(imported.receipt_id)).toEqual(beforeMerge);
    expect(await authorityGrantSnapshot(ccdaAuthorityGrant.grantId)).toEqual(beforeGrant);
    expect(await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id))
      .toEqual(beforeRawArtifact);

    await expect(importCCDA(xml, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: ccdaAuthorityFor(xml, {
        patientUid: CCDA_PATIENT_C_UID,
        patientId: patientIds.get(CCDA_PATIENT_C_UID),
        authorityGrant: unrelatedAuthorityGrant,
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    const changedXml = ccdaDocument({ medicationName: 'Losartan 100 mg tablet' });
    await expect(importCCDA(changedXml, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: ccdaAuthorityFor(changedXml, {
        patientUid: CCDA_PATIENT_A_UID,
        patientId: patientIds.get(CCDA_PATIENT_A_UID),
        authorityGrant: survivorAuthorityGrant,
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    await expect(importCCDA(xml, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: ccdaAuthorityFor(xml, {
        patientUid: CCDA_PATIENT_A_UID,
        patientId: patientIds.get(CCDA_PATIENT_A_UID),
        idempotencyKey: `${CCDA_IDEMPOTENCY_KEY}:changed`,
        authorityGrant: survivorAuthorityGrant,
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_RECEIPT_REPLAY_MISMATCH',
    });

    expect(await tenantCounts()).toEqual(beforeReplay);
    expect(await receiptSnapshot(imported.receipt_id)).toEqual(beforeMerge);
    expect(await authorityGrantSnapshot(ccdaAuthorityGrant.grantId)).toEqual(beforeGrant);
    expect(await rawArtifactSnapshot(beforeMerge.documents[0].raw_artifact_id))
      .toEqual(beforeRawArtifact);
  });
});
