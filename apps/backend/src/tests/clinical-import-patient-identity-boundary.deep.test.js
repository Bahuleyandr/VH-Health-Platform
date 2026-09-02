// Patient identity is the clinical-import authorization boundary. Native VH
// identifiers may bind directly; every external alias must already belong to
// exactly one tenant patient (or its exact merge survivor) before any resource
// is rewritten. Exact receipt replay remains independent of later alias state.
//
// Receipt and authority rows are append-only. This suite therefore uses unique
// tenants and source identities and leaves its evidence in the ephemeral CI DB.

import crypto from 'node:crypto';

import { jest } from '@jest/globals';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { importCCDA, importFhirBundle } from '../services/import/patientDataImport.js';
import { clinicalImportSha256 } from '../services/import/clinicalImportReceiptService.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;
jest.setTimeout(60_000);

const TENANT_ID = crypto.randomUUID();
const FOREIGN_TENANT_ID = crypto.randomUUID();
const TARGET_PATIENT_UID = crypto.randomUUID();
const WRONG_PATIENT_UID = crypto.randomUUID();
const MERGED_SOURCE_UID = crypto.randomUUID();
const FOREIGN_PATIENT_UID = crypto.randomUUID();
const IMPORTER_UID = crypto.randomUUID();
const SUFFIX = TENANT_ID.slice(0, 8);

const patientIds = new Map();
let facilityId;

function phone(prefix) {
  return `${prefix}${crypto.randomInt(100_000_000, 1_000_000_000)}`;
}

async function tenantQuery(tenantId, sql, ...params) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

async function localQuery(sql, ...params) {
  return tenantQuery(TENANT_ID, sql, ...params);
}

async function seedAuthorityGrant({ patientUid, sourceSystem, documentFormat }) {
  const grantId = crypto.randomUUID();
  const ownerEvidenceRef = `urn:vhhealth:test:clinical-import-identity:${grantId}`;
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
  await localQuery(
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
    'Focused clinical-import patient identity boundary fixture',
    clinicalImportSha256(`clinical-import-identity-grant:${grantId}`),
  );
  return { grantId, ownerEvidenceSha256 };
}

async function authorityFor(payload, {
  label,
  documentFormat = 'fhir_bundle',
  patientUid = TARGET_PATIENT_UID,
  patientId = patientIds.get(patientUid),
} = {}) {
  const identity = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const sourceSystem = `jest-clinical-import-identity-${SUFFIX}-${identity}`;
  const sourceDocumentId = `clinical-import-identity-${identity}`;
  const authorityGrant = await seedAuthorityGrant({
    patientUid,
    sourceSystem,
    documentFormat,
  });
  const sourcePayloadSha256 = clinicalImportSha256(payload);
  const policy = {
    access_decision: 'allow',
    policy_code: 'patient.record.upload',
    policy_version: 'clinical-import-patient-identity-v1',
    patient_uid: patientUid,
    source_document_id: sourceDocumentId,
  };
  const accessDecisionEvidence = {
    ...policy,
    policy_hash: clinicalImportSha256(policy),
    access_source: 'focused_deep_test',
    owner_evidence_sha256: authorityGrant.ownerEvidenceSha256,
  };
  return {
    patientUid,
    patientId,
    sourceSystem,
    sourceDocumentId,
    sourceFacilityId: facilityId,
    authorityGrantId: authorityGrant.grantId,
    sourceSignatureSha256: clinicalImportSha256(`signature:${sourcePayloadSha256}`),
    sourcePayloadSha256,
    idempotencyKey: `clinical-import-identity:${identity}:${crypto.randomUUID()}`,
    actorUid: IMPORTER_UID,
    actorRole: 'MEDICAL_RECORDS',
    ingestionMode: 'manual_medical_records',
    requestId: crypto.randomUUID(),
    rawDocument: Buffer.from(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      'utf8',
    ),
    rawContentType: documentFormat === 'ccda' ? 'application/xml' : 'application/fhir+json',
    accessDecisionEvidence,
    revalidateAccess: async () => accessDecisionEvidence,
  };
}

function fhirSignature(label) {
  return {
    when: '2026-09-02T10:00:00.000Z',
    who: {
      identifier: {
        system: 'urn:vhhealth:test:source-author',
        value: `author-${SUFFIX}-${label}`,
      },
      display: `Clinical Import Identity Author ${label}`,
    },
  };
}

function patientEntry({
  id = null,
  fullUrl = null,
  identifiers = [],
} = {}) {
  return {
    ...(fullUrl ? { fullUrl } : {}),
    resource: {
      resourceType: 'Patient',
      ...(id ? { id } : {}),
      ...(identifiers.length ? { identifier: identifiers } : {}),
      active: true,
      name: [{ use: 'official', text: `Identity Target ${SUFFIX}` }],
    },
  };
}

function fhirPatientBundle(entry, label) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    signature: fhirSignature(label),
    entry: [entry],
  };
}

function observationOnlyBundle(patientReference, label) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    signature: fhirSignature(label),
    entry: [{
      resource: {
        resourceType: 'Observation',
        id: crypto.randomUUID(),
        status: 'final',
        category: [{ coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: 'laboratory',
        }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '94531-1' }] },
        subject: { reference: patientReference },
        performer: [{
          identifier: {
            system: 'urn:vhhealth:test:source-author',
            value: `performer-${SUFFIX}-${label}`,
          },
          display: `Observation Source Author ${label}`,
        }],
        effectiveDateTime: '2026-09-02T10:00:00.000Z',
        valueString: 'identity-boundary-only',
      },
    }],
  };
}

function ccdaDocument({ root, extension, label }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5" extension="document-${SUFFIX}-${label}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <title>Clinical import patient identity boundary</title>
  <effectiveTime value="20260902100000+0530"/>
  <author>
    <time value="20260902100000+0530"/>
    <assignedAuthor>
      <id root="2.16.840.1.113883.4.6" extension="author-${SUFFIX}-${label}"/>
      <assignedPerson><name><given>Identity</given><family>Author</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <recordTarget>
    <patientRole>
      <id root="${root}" extension="${extension}"/>
      <patient>
        <name use="L"><given>Identity</given><family>Target</family></name>
      </patient>
    </patientRole>
  </recordTarget>
  <component><structuredBody/></component>
</ClinicalDocument>`;
}

async function seedExternalIdentifier({
  tenantId = TENANT_ID,
  patientUid = TARGET_PATIENT_UID,
  value,
  issuer = null,
  status = 'active',
  mergedIntoUid = null,
  expiresAt = null,
}) {
  const rows = await tenantQuery(
    tenantId,
    `INSERT INTO patient_identifiers
       (tenant_id, patient_uid, identifier_type, identifier_value, issuer,
         status, merged_into_uid, expires_at, metadata, created_at, updated_at)
      VALUES
        ($1::uuid, $2::uuid, 'external_emr', $3, $4, $5, $6::uuid,
         $7::timestamptz, $8::jsonb, NOW(), NOW())
     RETURNING id, patient_uid, identifier_value, issuer, status, merged_into_uid`,
    tenantId,
    patientUid,
    value,
    issuer,
    status,
    mergedIntoUid,
    expiresAt,
    JSON.stringify({ source: 'clinical_import_patient_identity_boundary_test' }),
  );
  return rows[0];
}

async function identifierCounts() {
  const [local] = await localQuery(
    `SELECT COUNT(*)::int AS count
       FROM patient_identifiers
      WHERE tenant_id=$1::uuid`,
    TENANT_ID,
  );
  const [foreign] = await tenantQuery(
    FOREIGN_TENANT_ID,
    `SELECT COUNT(*)::int AS count
       FROM patient_identifiers
      WHERE tenant_id=$1::uuid`,
    FOREIGN_TENANT_ID,
  );
  return { local: local.count, foreign: foreign.count };
}

async function expectIdentifierCountUnchanged(action) {
  const before = await identifierCounts();
  await action();
  expect(await identifierCounts()).toEqual(before);
}

async function receiptIdentity(receiptId) {
  const rows = await localQuery(
    `SELECT document.patient_identifier_ids,
            document.patient_identity_binding_sha256,
            document.access_decision_evidence,
            document.source_author_evidence,
            raw.raw_payload_bytes::int AS raw_payload_bytes,
            raw.raw_content_type, raw.canonicalization_version,
            raw.signature_verification_status,
            raw.source_author_evidence AS raw_source_author_evidence
       FROM clinical_import_document_receipts AS document
       JOIN clinical_import_raw_artifacts AS raw
         ON raw.tenant_id=document.tenant_id
        AND raw.id=document.raw_artifact_id
      WHERE document.tenant_id=$1::uuid
        AND document.id=$2::uuid`,
    TENANT_ID,
    receiptId,
  );
  return rows[0] || null;
}

d('clinical import patient identity boundary (real PostgreSQL)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW()),
         ($4::uuid, $5, $6, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())`,
      TENANT_ID,
      `clinical-import-identity-${SUFFIX}`,
      `Clinical Import Identity ${SUFFIX}`,
      FOREIGN_TENANT_ID,
      `clinical-import-identity-foreign-${SUFFIX}`,
      `Clinical Import Identity Foreign ${SUFFIX}`,
    );

    await setTenantTx(TENANT_ID, async (tx) => {
      const users = await tx.$queryRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, name, role, is_active, status, is_deleted,
            merged_into_uid, merged_at, updated_at)
         VALUES
           ($1::uuid, $5::uuid, $6, $9,  'PATIENT', TRUE,  'active', FALSE, NULL, NULL, NOW()),
           ($2::uuid, $5::uuid, $7, $10, 'PATIENT', TRUE,  'active', FALSE, NULL, NULL, NOW()),
           ($3::uuid, $5::uuid, $8, $11, 'PATIENT', FALSE, 'merged', FALSE, $1::uuid, NOW(), NOW()),
           ($4::uuid, $5::uuid, $12, $13, 'MEDICAL_RECORDS', TRUE, 'active', FALSE, NULL, NULL, NOW())
         RETURNING id, uid`,
        TARGET_PATIENT_UID,
        WRONG_PATIENT_UID,
        MERGED_SOURCE_UID,
        IMPORTER_UID,
        TENANT_ID,
        phone('8'),
        phone('7'),
        phone('6'),
        `Identity Target ${SUFFIX}`,
        `Identity Wrong Patient ${SUFFIX}`,
        `Identity Merged Source ${SUFFIX}`,
        phone('9'),
        `Identity Importer ${SUFFIX}`,
      );
      for (const user of users) patientIds.set(String(user.uid), Number(user.id));

      const facilities = await tx.$queryRawUnsafe(
        `INSERT INTO facilities
           (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, $2, $3, 'active', FALSE)
         RETURNING id`,
        TENANT_ID,
        `CI-ID-${SUFFIX}`,
        `Clinical Import Identity Facility ${SUFFIX}`,
      );
      facilityId = Number(facilities[0].id);
    });

    await setTenantTx(FOREIGN_TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, name, role, is_active, status, is_deleted, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'PATIENT', TRUE, 'active', FALSE, NOW())`,
        FOREIGN_PATIENT_UID,
        FOREIGN_TENANT_ID,
        phone('5'),
        `Identity Foreign Patient ${SUFFIX}`,
      );
    });
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('accepts an exact native VH target from the standard FHIR Patient.identifier field', async () => {
    const bundle = fhirPatientBundle(patientEntry({
      id: `local-patient-${SUFFIX}`,
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      identifiers: [{ system: 'urn:vhhealth:uid', value: TARGET_PATIENT_UID }],
    }), 'native-local-aliases');
    expect(bundle.entry[0].resource.identifier).toEqual([
      { system: 'urn:vhhealth:uid', value: TARGET_PATIENT_UID },
    ]);
    expect(bundle.entry[0].resource.identifiers).toBeUndefined();
    const authority = await authorityFor(bundle, { label: 'native-local-aliases' });

    await expectIdentifierCountUnchanged(async () => {
      const result = await importFhirBundle(bundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority,
      });
      expect(result).toMatchObject({ replayed: false, deduplicated: 1 });
      const identity = await receiptIdentity(result.receipt_id);
      expect(identity).toMatchObject({
        patient_identifier_ids: [],
        raw_payload_bytes: authority.rawDocument.length,
        raw_content_type: 'application/fhir+json',
        canonicalization_version: 'exact-http-body+fhir-canonical-json-v1',
        signature_verification_status: 'asserted_unverified',
      });
      expect(identity.patient_identity_binding_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.access_decision_evidence).toMatchObject({
        contract_version: 'clinical-import-access-decision-v1',
        decision: 'allow',
        patient_uid: TARGET_PATIENT_UID,
      });
      expect(identity.source_author_evidence.authors).not.toHaveLength(0);
      expect(identity.raw_source_author_evidence).toEqual(identity.source_author_evidence);
    });
  });

  it('holds display-only FHIR source-author evidence before creating custody receipts', async () => {
    const bundle = fhirPatientBundle(patientEntry({
      id: TARGET_PATIENT_UID,
      identifiers: [{ system: 'urn:vhhealth:uid', value: TARGET_PATIENT_UID }],
    }), 'display-only-author');
    bundle.signature.who = { display: 'Unbound Display-Only Author' };
    const authority = await authorityFor(bundle, { label: 'display-only-author' });

    await expectIdentifierCountUnchanged(async () => {
      await expect(importFhirBundle(bundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IMPORT_SOURCE_AUTHOR_IDENTITY_REQUIRED',
        details: {
          status: 'HELD_EXTERNAL_AUTHORITY',
          required_authority: 'CLINICAL_IMPORT_SOURCE_AUTHOR_IDENTITY_OWNER',
        },
      });
    });
    expect(await localQuery(
      `SELECT id
         FROM clinical_import_document_receipts
        WHERE tenant_id=$1::uuid AND source_system=$2 AND source_document_id=$3`,
      TENANT_ID,
      authority.sourceSystem,
      authority.sourceDocumentId,
    )).toEqual([]);
  });

  it('accepts an Observation-only exact Patient/<target> reference without creating a mapping', async () => {
    const bundle = observationOnlyBundle(
      `Patient/${TARGET_PATIENT_UID}`,
      'observation-exact-target',
    );
    const authority = await authorityFor(bundle, { label: 'observation-exact-target' });

    await expectIdentifierCountUnchanged(async () => {
      const result = await importFhirBundle(bundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority,
      });
      expect(result).toMatchObject({ replayed: false });
      expect(result.receipt_id).toEqual(expect.any(String));
      expect(await receiptIdentity(result.receipt_id)).toMatchObject({
        patient_identifier_ids: [],
      });
    });
  });

  it('rejects multiple Patient entries and conflicting duplicate native VH identifiers', async () => {
    const multiplePatients = {
      resourceType: 'Bundle',
      type: 'collection',
      signature: fhirSignature('multiple-patients'),
      entry: [
        patientEntry({
          id: `patient-one-${SUFFIX}`,
          identifiers: [{ system: 'urn:vhhealth:uid', value: TARGET_PATIENT_UID }],
        }),
        patientEntry({
          id: `patient-two-${SUFFIX}`,
          identifiers: [{ system: 'urn:vhhealth:uid', value: TARGET_PATIENT_UID }],
        }),
      ],
    };
    const multipleAuthority = await authorityFor(multiplePatients, { label: 'multiple-patients' });
    const conflictingIdentifiers = fhirPatientBundle(patientEntry({
      id: TARGET_PATIENT_UID,
      identifiers: [
        { system: 'urn:vhhealth:uid', value: TARGET_PATIENT_UID },
        { system: 'urn:vhhealth:uid', value: WRONG_PATIENT_UID },
      ],
    }), 'conflicting-native-identifiers');
    expect(conflictingIdentifiers.entry[0].resource.identifier).toHaveLength(2);
    expect(conflictingIdentifiers.entry[0].resource.identifiers).toBeUndefined();
    const conflictingAuthority = await authorityFor(conflictingIdentifiers, {
      label: 'conflicting-native-identifiers',
    });

    await expectIdentifierCountUnchanged(async () => {
      await expect(importFhirBundle(multiplePatients, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: multipleAuthority,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IMPORT_PATIENT_IDENTITY_AMBIGUOUS',
      });
      await expect(importFhirBundle(conflictingIdentifiers, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: conflictingAuthority,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IMPORT_PATIENT_IDENTITY_MISMATCH',
      });
    });
  });

  it('accepts external FHIR Patient id and fullUrl only through one active mapping', async () => {
    const externalId = `external-id-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const idMapping = await seedExternalIdentifier({ value: externalId });
    const idBundle = fhirPatientBundle(patientEntry({ id: externalId }), 'external-id');
    const idAuthority = await authorityFor(idBundle, { label: 'external-id' });

    const externalFullUrl = `urn:uuid:${crypto.randomUUID()}`;
    const fullUrlMapping = await seedExternalIdentifier({ value: externalFullUrl });
    const fullUrlBundle = fhirPatientBundle(
      patientEntry({ fullUrl: externalFullUrl }),
      'external-full-url',
    );
    const fullUrlAuthority = await authorityFor(fullUrlBundle, { label: 'external-full-url' });

    await expectIdentifierCountUnchanged(async () => {
      const idResult = await importFhirBundle(idBundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: idAuthority,
      });
      expect(await receiptIdentity(idResult.receipt_id)).toMatchObject({
        patient_identifier_ids: [idMapping.id],
      });

      const fullUrlResult = await importFhirBundle(fullUrlBundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: fullUrlAuthority,
      });
      expect(await receiptIdentity(fullUrlResult.receipt_id)).toMatchObject({
        patient_identifier_ids: [fullUrlMapping.id],
      });
    });
  });

  it('rejects expired aliases for new documents but preserves exact historical receipt replay', async () => {
    const externalId = `expiring-id-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const mapping = await seedExternalIdentifier({
      value: externalId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const bundle = fhirPatientBundle(patientEntry({ id: externalId }), 'expiring-id');
    const authority = await authorityFor(bundle, { label: 'expiring-id' });
    const first = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(await receiptIdentity(first.receipt_id)).toMatchObject({
      patient_identifier_ids: [mapping.id],
    });

    await localQuery(
      `UPDATE patient_identifiers
          SET expires_at=clock_timestamp() - INTERVAL '1 second', updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      TENANT_ID,
      mapping.id,
    );
    let directDbExpiryFailure;
    try {
      await localQuery(
        `INSERT INTO clinical_import_document_receipts
         (id, tenant_id, patient_id, patient_uid, source_facility_id,
          authority_grant_id, raw_artifact_id, patient_identifier_ids,
          patient_identity_binding_sha256, access_decision_evidence,
          source_author_evidence, actor_uid, actor_role, ingestion_mode,
          document_format, source_system, source_document_id,
          asserted_source_signature_sha256, source_payload_sha256,
          source_identity_sha256, idempotency_key_sha256,
          resource_manifest_sha256, resource_manifest, result, status,
          request_id, canonical_timeline_event_id, canonical_audit_event_id,
          contract_version)
       SELECT gen_random_uuid(), tenant_id, patient_id, patient_uid,
              source_facility_id, authority_grant_id, raw_artifact_id,
              patient_identifier_ids, patient_identity_binding_sha256,
              access_decision_evidence, source_author_evidence, actor_uid,
              actor_role, ingestion_mode, document_format, source_system,
              source_document_id, asserted_source_signature_sha256,
              source_payload_sha256, source_identity_sha256,
              idempotency_key_sha256, resource_manifest_sha256,
              resource_manifest, result, status, request_id,
              canonical_timeline_event_id, canonical_audit_event_id,
              contract_version
         FROM clinical_import_document_receipts
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        TENANT_ID,
        first.receipt_id,
      );
    } catch (error) {
      directDbExpiryFailure = error;
    }
    expect(directDbExpiryFailure).toMatchObject({ code: 'P2010' });
    expect(String(directDbExpiryFailure?.message)).toContain(
      'clinical import patient identifiers are not the exact active patient binding',
    );
    const replay = await importFhirBundle(structuredClone(bundle), IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(replay).toMatchObject({ receipt_id: first.receipt_id, replayed: true });

    const newAuthority = await authorityFor(bundle, { label: 'expired-new-document' });
    await expect(importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority: newAuthority,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED',
    });
  });

  it('rejects missing, cross-tenant, wrong-patient, retired, and ambiguous mappings', async () => {
    const missingValue = `missing-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const crossTenantValue = `cross-tenant-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const wrongPatientValue = `wrong-patient-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const retiredValue = `retired-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const ambiguousValue = `ambiguous-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;

    await seedExternalIdentifier({
      tenantId: FOREIGN_TENANT_ID,
      patientUid: FOREIGN_PATIENT_UID,
      value: crossTenantValue,
    });
    await seedExternalIdentifier({ patientUid: WRONG_PATIENT_UID, value: wrongPatientValue });
    await seedExternalIdentifier({ value: retiredValue, status: 'retired' });
    await seedExternalIdentifier({ value: ambiguousValue });
    await seedExternalIdentifier({
      patientUid: MERGED_SOURCE_UID,
      value: ambiguousValue,
      status: 'merged_into',
      mergedIntoUid: WRONG_PATIENT_UID,
    });

    const cases = [
      { label: 'missing', value: missingValue, code: 'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED' },
      { label: 'cross-tenant', value: crossTenantValue, code: 'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED' },
      { label: 'wrong-patient', value: wrongPatientValue, code: 'IMPORT_PATIENT_IDENTITY_MISMATCH' },
      { label: 'retired', value: retiredValue, code: 'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED' },
      { label: 'ambiguous', value: ambiguousValue, code: 'IMPORT_PATIENT_IDENTITY_AMBIGUOUS' },
    ];
    const attempts = [];
    for (const item of cases) {
      const bundle = fhirPatientBundle(patientEntry({ id: item.value }), item.label);
      attempts.push({
        ...item,
        bundle,
        authority: await authorityFor(bundle, { label: item.label }),
      });
    }

    await expectIdentifierCountUnchanged(async () => {
      for (const attempt of attempts) {
        await expect(importFhirBundle(attempt.bundle, IMPORTER_UID, {
          tenantId: TENANT_ID,
          authority: attempt.authority,
        })).rejects.toMatchObject({ statusCode: 409, code: attempt.code });
      }
    });
  });

  it('resolves a merged_into mapping only to its exact requested survivor', async () => {
    const survivorValue = `merged-survivor-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const wrongSurvivorValue = `merged-wrong-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const survivorMapping = await seedExternalIdentifier({
      patientUid: MERGED_SOURCE_UID,
      value: survivorValue,
      status: 'merged_into',
      mergedIntoUid: TARGET_PATIENT_UID,
    });
    await seedExternalIdentifier({
      patientUid: MERGED_SOURCE_UID,
      value: wrongSurvivorValue,
      status: 'merged_into',
      mergedIntoUid: WRONG_PATIENT_UID,
    });
    const survivorBundle = fhirPatientBundle(
      patientEntry({ id: survivorValue }),
      'merged-survivor',
    );
    const survivorAuthority = await authorityFor(survivorBundle, { label: 'merged-survivor' });
    const wrongBundle = fhirPatientBundle(
      patientEntry({ id: wrongSurvivorValue }),
      'merged-wrong-survivor',
    );
    const wrongAuthority = await authorityFor(wrongBundle, { label: 'merged-wrong-survivor' });

    await expectIdentifierCountUnchanged(async () => {
      const result = await importFhirBundle(survivorBundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: survivorAuthority,
      });
      expect(await receiptIdentity(result.receipt_id)).toMatchObject({
        patient_identifier_ids: [survivorMapping.id],
      });
      await expect(importFhirBundle(wrongBundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: wrongAuthority,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IMPORT_PATIENT_IDENTITY_MISMATCH',
      });
    });
  });

  it('binds C-CDA root plus extension and rejects the same extension from another root', async () => {
    const extension = `ccda-external-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const boundRoot = '2.16.840.1.113883.19.5';
    const collidingRoot = '2.16.840.1.113883.19.999';
    const mapping = await seedExternalIdentifier({
      value: extension,
      issuer: boundRoot,
    });
    const validXml = ccdaDocument({ root: boundRoot, extension, label: 'valid-root' });
    const validAuthority = await authorityFor(validXml, {
      label: 'ccda-valid-root',
      documentFormat: 'ccda',
    });
    const collisionXml = ccdaDocument({
      root: collidingRoot,
      extension,
      label: 'colliding-root',
    });
    const collisionAuthority = await authorityFor(collisionXml, {
      label: 'ccda-colliding-root',
      documentFormat: 'ccda',
    });

    await expectIdentifierCountUnchanged(async () => {
      const result = await importCCDA(validXml, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: validAuthority,
      });
      expect(await receiptIdentity(result.receipt_id)).toMatchObject({
        patient_identifier_ids: [mapping.id],
      });
      await expect(importCCDA(collisionXml, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority: collisionAuthority,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IMPORT_PATIENT_IDENTIFIER_MAPPING_REQUIRED',
      });
    });
  });

  it('replays an exact receipt after its mapping is retired or merge-retargeted', async () => {
    const externalId = `replay-alias-${SUFFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const mapping = await seedExternalIdentifier({ value: externalId });
    const bundle = fhirPatientBundle(patientEntry({ id: externalId }), 'mapping-replay');
    const authority = await authorityFor(bundle, { label: 'mapping-replay' });
    const countsBeforeImport = await identifierCounts();
    const first = await importFhirBundle(bundle, IMPORTER_UID, {
      tenantId: TENANT_ID,
      authority,
    });
    expect(first).toMatchObject({ replayed: false });
    expect(await receiptIdentity(first.receipt_id)).toMatchObject({
      patient_identifier_ids: [mapping.id],
    });

    await expectIdentifierCountUnchanged(async () => {
      await localQuery(
        `UPDATE patient_identifiers
            SET status='retired', merged_into_uid=NULL, updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        TENANT_ID,
        mapping.id,
      );
      const retiredReplay = await importFhirBundle(bundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority,
      });
      expect(retiredReplay).toEqual({ ...first, replayed: true });

      await localQuery(
        `UPDATE patient_identifiers
            SET patient_uid=$1::uuid, status='merged_into',
                merged_into_uid=$2::uuid, updated_at=NOW()
          WHERE tenant_id=$3::uuid AND id=$4::int`,
        MERGED_SOURCE_UID,
        TARGET_PATIENT_UID,
        TENANT_ID,
        mapping.id,
      );
      const mergedReplay = await importFhirBundle(bundle, IMPORTER_UID, {
        tenantId: TENANT_ID,
        authority,
      });
      expect(mergedReplay).toEqual({ ...first, replayed: true });
    });
    expect(await identifierCounts()).toEqual(countsBeforeImport);
  });
});
