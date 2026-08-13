import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SEVERITIES = new Set(['MILD', 'MODERATE', 'SEVERE']);

function requiredUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'FHIR_ALLERGY_IDENTITY_INVALID');
  }
  return normalized;
}

function normalizeText(value, maxLength, { required = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/gu, ' ');
  if ((required && !normalized) || normalized.length > maxLength) {
    throw AppError.badRequest('FHIR AllergyIntolerance content is invalid', 'FHIR_ALLERGY_CONTENT_INVALID');
  }
  return normalized || null;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function allergyIdentityFingerprint({ patientUid, allergen }) {
  return sha256(`${patientUid}\n${allergen.toLocaleLowerCase('en-US')}`);
}

function allergyPayloadFingerprint({ severity, reaction }) {
  return sha256(`${severity}\n${String(reaction || '').toLocaleLowerCase('en-US')}`);
}

function normalizeAllergyInput(input) {
  const tenantId = requiredUuid(input.tenantId, 'FHIR tenant id');
  const patientUid = requiredUuid(input.patientUid, 'FHIR patient id');
  const allergen = normalizeText(input.allergen, 255, { required: true });
  const severity = String(input.severity || 'MILD').trim().toUpperCase();
  if (!ALLOWED_SEVERITIES.has(severity)) {
    throw AppError.badRequest('FHIR AllergyIntolerance severity is invalid', 'FHIR_ALLERGY_SEVERITY_INVALID');
  }
  const reaction = normalizeText(input.reaction, 4000);
  const resourceFingerprint = allergyIdentityFingerprint({ patientUid, allergen });
  const payloadSha256 = allergyPayloadFingerprint({ severity, reaction });
  return {
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
    resourceFingerprint,
    payloadSha256,
  };
}

function publicAllergy(row) {
  if (!row) return null;
  return {
    ...row,
    id: `pa-${row.id}`,
    allergen: row.allergy_name,
    recorded_at: row.created_at,
  };
}

async function findReceipt(tx, { tenantId, resourceFingerprint }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT receipt.tenant_id::text, receipt.resource_fingerprint,
            receipt.payload_sha256, receipt.patient_uid::text,
            receipt.allergy_id, receipt.timeline_event_id::text,
            receipt.audit_event_id::text, receipt.recorded_at,
            allergy.id, allergy.allergy_name, allergy.severity, allergy.reaction,
            allergy.is_active, allergy.created_at
       FROM fhir_allergy_intolerance_receipts receipt
       JOIN patient_allergies allergy
         ON allergy.tenant_id = receipt.tenant_id
        AND allergy.id = receipt.allergy_id
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.resource_fingerprint = $2
      LIMIT 1`,
    tenantId,
    resourceFingerprint,
  );
  return rows[0] || null;
}

function assertMatchingReceipt(receipt, { patientUid, payloadSha256 }) {
  if (
    String(receipt.patient_uid).toLowerCase() !== patientUid
    || receipt.payload_sha256 !== payloadSha256
  ) {
    throw AppError.conflict(
      'This patient and allergen were already recorded with different clinical content',
      'FHIR_ALLERGY_RECEIPT_IDENTITY_DRIFT',
    );
  }
}

async function findUnreceiptedAllergy(tx, {
  tenantId, patientUid, allergen, severity, reaction,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT allergy.id, allergy.patient_uid::text, allergy.allergy_name,
            allergy.severity, allergy.reaction, allergy.is_active,
            allergy.created_at
       FROM patient_allergies allergy
       LEFT JOIN fhir_allergy_intolerance_receipts receipt
         ON receipt.tenant_id = allergy.tenant_id
        AND receipt.allergy_id = allergy.id
      WHERE allergy.tenant_id = $1::uuid
        AND allergy.patient_uid = $2::uuid
        AND LOWER(REGEXP_REPLACE(BTRIM(allergy.allergy_name), '\\s+', ' ', 'g')) = LOWER($3)
        AND UPPER(COALESCE(allergy.severity, 'MILD')) = $4
        AND LOWER(COALESCE(REGEXP_REPLACE(BTRIM(allergy.reaction), '\\s+', ' ', 'g'), '')) = LOWER(COALESCE($5, ''))
        AND allergy.is_active IS NOT FALSE
        AND receipt.allergy_id IS NULL
      ORDER BY allergy.created_at ASC NULLS LAST, allergy.id ASC
      LIMIT 1
      FOR UPDATE OF allergy`,
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
  );
  return rows[0] || null;
}

export async function createFhirAllergyIntolerance(input = {}) {
  const normalized = normalizeAllergyInput(input);
  const {
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
    resourceFingerprint,
    payloadSha256,
  } = normalized;

  return setTenantTx(tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
         pg_catalog.hashtextextended($1::text, 666)
       )::text AS lock_result`,
      `${tenantId}:fhir-allergy:${resourceFingerprint}`,
    );

    const existing = await findReceipt(tx, { tenantId, resourceFingerprint });
    if (existing) {
      assertMatchingReceipt(existing, { patientUid, payloadSha256 });
      return { created: false, duplicate: true, allergy: publicAllergy(existing), receipt: existing };
    }

    let detail = await findUnreceiptedAllergy(tx, {
      tenantId,
      patientUid,
      allergen,
      severity,
      reaction,
    });
    const adopted = Boolean(detail);
    if (!detail) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO patient_allergies
           (patient_uid, allergy_name, severity, reaction, is_active, tenant_id, created_at)
         VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())
         RETURNING id, patient_uid::text, allergy_name, severity, reaction,
                   is_active, created_at`,
        patientUid,
        allergen,
        severity,
        reaction,
        tenantId,
      );
      detail = rows[0];
    }

    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'allergy.recorded',
      eventStatus: 'active',
      sourceTable: 'patient_allergies',
      sourceId: String(detail.id),
      resourceType: 'allergy',
      resourceId: String(detail.id),
      actorUid: input.actorUid || null,
      actorRole: input.actorRole || 'FHIR_CLIENT',
      visibleToPatient: true,
      requestId: input.requestId || null,
      summary: `Allergy recorded: ${detail.allergy_name}`,
      payload: {
        allergy_id: detail.id,
        allergy_name: detail.allergy_name,
        severity: detail.severity,
        reaction: detail.reaction,
        status: 'active',
        source: 'FHIR R4',
      },
      afterState: {
        allergy_id: detail.id,
        allergy_name: detail.allergy_name,
        severity: detail.severity,
        reaction: detail.reaction,
        adopted_existing_detail: adopted,
      },
      metadata: {
        protocol: 'FHIR R4',
        resource_type: 'AllergyIntolerance',
        resource_fingerprint: resourceFingerprint,
        payload_sha256: payloadSha256,
      },
      timelineIdempotencyKey: `fhir-allergy:${tenantId}:${resourceFingerprint}:timeline`,
      auditIdempotencyKey: `fhir-allergy:${tenantId}:${resourceFingerprint}:audit`,
    }, { db: tx, strict: true });

    const receipts = await tx.$queryRawUnsafe(
      `INSERT INTO fhir_allergy_intolerance_receipts
         (tenant_id, resource_fingerprint, payload_sha256, patient_uid,
          allergy_id, timeline_event_id, audit_event_id)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid, $7::uuid)
       RETURNING tenant_id::text, resource_fingerprint, payload_sha256,
                 patient_uid::text, allergy_id, timeline_event_id::text,
                 audit_event_id::text, recorded_at`,
      tenantId,
      resourceFingerprint,
      payloadSha256,
      patientUid,
      detail.id,
      canonical.timeline.id,
      canonical.audit.id,
    );

    return {
      created: !adopted,
      duplicate: adopted,
      allergy: publicAllergy(detail),
      receipt: receipts[0],
    };
  });
}

export async function listFhirAllergyIntolerances(input = {}) {
  const tenantId = requiredUuid(input.tenantId, 'FHIR tenant id');
  const patientUid = input.patientUid == null || input.patientUid === ''
    ? null
    : requiredUuid(input.patientUid, 'FHIR patient id');
  const limit = Number.parseInt(input.limit, 10);
  const offset = Number.parseInt(input.offset, 10);
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;
  const boundedOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;

  const rows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, patient_uid::text, allergy_name, severity, reaction,
            is_active, created_at
       FROM patient_allergies
      WHERE tenant_id = $1::uuid
        AND is_active IS NOT FALSE
        AND ($2::uuid IS NULL OR patient_uid = $2::uuid)
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT $3 OFFSET $4`,
    tenantId,
    patientUid,
    boundedLimit,
    boundedOffset,
  ));

  return rows.map(publicAllergy);
}

export const __testing__ = {
  allergyIdentityFingerprint,
  allergyPayloadFingerprint,
  normalizeAllergyInput,
  publicAllergy,
};

export default {
  createFhirAllergyIntolerance,
  listFhirAllergyIntolerances,
};
