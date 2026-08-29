// src/services/pharmacy/pharmacistVerificationService.js
//
// Roadmap B1 — pharmacist clinical verification of pharmacy orders.
//
// The pharmacy lifecycle had no state where a pharmacist reviews the order
// against allergies/interactions before PREPARING. This service owns that
// gate:
//
//   * verifyOrder()  — runs the full prescription-safety engine
//     (allergy stores + B2 drug KB + B7 problem list) against the order's
//     item list, persists the verdict on pharmacy_orders, records
//     medication_safety_reviews rows + a canonical timeline/audit event in
//     the same transaction, and enforces override-with-reason when blockers
//     are present.
//   * assertVerificationCleared() — shared gate used by the PREPARING /
//     DISPATCH / counter-dispense controllers.
//   * ensurePackBarcode() / getPackLabel() — platform-issued med-pack
//     barcode + printable label payload; the MAR drug-right scan matches
//     this barcode exactly (marFiveRightsService).

import { createHash, randomBytes } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import {
  loadActiveTherapySnapshot,
  validatePrescriptionSafety,
} from '../../utils/clinical/prescriptionSafetyCheck.js';
import { evaluateDrugKb, loadDrugKbRevision } from '../clinical/drugKnowledgeBaseService.js';
import {
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from '../clinical/canonicalClinicalPlatformService.js';
import {
  BCMA_CONFIG,
  CLINICAL_VERIFICATION_STATUS,
  VERIFICATION_CLEARED_STATUSES,
} from '../../config/pharmacyConfig.js';
import {
  loadPharmacyOrderCommandReceiptTx,
  storePharmacyOrderCommandReceiptTx,
} from './pharmacyOrderCommandReceiptService.js';
import { assertPharmacyFacilityGrant } from './pharmacyFacilityAuthorityService.js';

const VERIFIABLE_ORDER_STATUSES = ['PENDING', 'CONFIRMED'];
const LEGACY_REVERIFIABLE_ORDER_STATUSES = ['PREPARING', 'READY', 'DISPATCHED'];
const CLINICAL_VERIFIER_ROLES = new Set(['PHARMACY_STAFF', 'PHARMACY_INCHARGE']);
const CLINICAL_OVERRIDE_ROLES = new Set(['PHARMACY_INCHARGE']);
const CLINICAL_RULESET_VERSION = 2;
const MIN_OVERRIDE_REASON_LENGTH = 10;

export function requiresActiveTherapyReconciliation(blockers = []) {
  return blockers.some((blocker) => (
    String(blocker?.type || '').startsWith('ACTIVE_THERAPY_')
    || String(blocker?.type || '').startsWith('DRUG_KB_IDENTITY_')
    || ['DRUG_KB_UNAVAILABLE', 'DRUG_KB_CHECK_ERROR', 'SAFETY_CHECK_ERROR']
      .includes(blocker?.type)
  ));
}

/**
 * Shared lock-order boundary for catalog mutation and pharmacist verification.
 * Catalog removal must acquire this transaction lock before locking a catalog
 * row; verification acquires it before locking an order row. The tenant-wide
 * namespace is intentionally conservative and removes the order/catalog lock
 * inversion without trusting an unlocked order item projection.
 */
export async function lockPharmacyCatalogAuthorityTx(tx, tenantId) {
  const tid = requireTenantId(tenantId);
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('vh:pharmacy_catalog_authority:' || $1::text, 753)
     )`,
    tid,
  );
}

function prescribedCatalogId(item) {
  return Number(item?.substitution_history?.[0]?.original_catalog_id ?? item?.catalog_id ?? 0) || null;
}

function stableCatalogAuthorityProjection(catalog, composition) {
  return {
    catalog_id: Number(catalog.id),
    name: catalog.name || null,
    generic_name: catalog.generic_name || null,
    composition_id: catalog.composition_id == null ? null : Number(catalog.composition_id),
    composition_key: composition?.composition_key || null,
    composition_label: composition?.display_label || null,
    active_ingredients: Array.isArray(composition?.active_ingredients)
      ? [...composition.active_ingredients]
      : [],
    strength: catalog.strength || null,
    strength_key: catalog.strength_key || null,
    strength_components: catalog.strength_components || null,
    form: catalog.form || null,
    form_key: catalog.form_key || null,
    release_key: catalog.release_key || null,
    route: catalog.route || null,
    composition_source: catalog.composition_source || null,
    composition_confidence: catalog.composition_confidence || null,
  };
}

async function resolveClinicalCatalogAuthority(
  db,
  tenantId,
  itemsList,
  { forUpdate = false } = {},
) {
  const lines = (Array.isArray(itemsList) ? itemsList : []).map((item, index) => ({
    item,
    orderLineIndex: Number(item?.order_line_index ?? index),
    prescribedCatalogId: prescribedCatalogId(item),
    currentCatalogId: Number(item?.catalog_id ?? 0) || null,
  }));
  if (!lines.length || lines.some((line) => (
    !Number.isInteger(line.prescribedCatalogId) || line.prescribedCatalogId <= 0
    || !Number.isInteger(line.currentCatalogId) || line.currentCatalogId <= 0
  ))) {
    throw AppError.conflict(
      'Every pharmacy order line must have a positive prescribed catalog identity before verification',
      'PHARMACY_VERIFY_CATALOG_IDENTITY_REQUIRED',
    );
  }

  const catalogIds = [...new Set(lines.flatMap((line) => [
    line.prescribedCatalogId,
    line.currentCatalogId,
  ]))].sort((a, b) => a - b);
  const catalogs = await db.$queryRawUnsafe(
    `SELECT id, name, generic_name, composition_id, strength, strength_key,
            strength_components, form, form_key, release_key, route,
            composition_source, composition_confidence
       FROM pharmacy_catalog
      WHERE tenant_id=$1::uuid
        AND id = ANY($2::int[])
        AND is_active=TRUE
      ORDER BY id
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    tenantId,
    catalogIds,
  );
  if (catalogs.length !== catalogIds.length) {
    throw AppError.conflict(
      'One or more prescribed catalog items are missing, inactive, or outside this tenant',
      'PHARMACY_VERIFY_CATALOG_AUTHORITY_UNAVAILABLE',
      { catalog_ids: catalogIds },
    );
  }

  const compositionIds = [...new Set(catalogs
    .map((catalog) => Number(catalog.composition_id))
    .filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  const compositions = compositionIds.length
    ? await db.$queryRawUnsafe(
      `SELECT id, composition_key, display_label, active_ingredients
         FROM drug_compositions
        WHERE id = ANY($1::int[])
        ORDER BY id
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      compositionIds,
    )
    : [];
  if (compositions.length !== compositionIds.length) {
    throw AppError.conflict(
      'One or more prescribed drug compositions are unavailable',
      'PHARMACY_VERIFY_COMPOSITION_AUTHORITY_UNAVAILABLE',
      { composition_ids: compositionIds },
    );
  }

  const catalogById = new Map(catalogs.map((catalog) => [Number(catalog.id), catalog]));
  const compositionById = new Map(compositions.map((composition) => [Number(composition.id), composition]));
  const unresolvedCompositionCatalogIds = catalogs
    .filter((catalog) => {
      const composition = compositionById.get(Number(catalog.composition_id));
      return !composition
        || !Array.isArray(composition.active_ingredients)
        || composition.active_ingredients.length === 0;
    })
    .map((catalog) => Number(catalog.id));
  if (unresolvedCompositionCatalogIds.length > 0) {
    throw AppError.conflict(
      'Every proposed medication must resolve to a governed non-empty drug composition',
      'PHARMACY_VERIFY_COMPOSITION_AUTHORITY_UNAVAILABLE',
      { catalog_ids: unresolvedCompositionCatalogIds },
    );
  }
  const projection = lines.map(({
    item,
    orderLineIndex,
    prescribedCatalogId: originalCatalogId,
    currentCatalogId,
  }) => {
    const prescribedCatalog = catalogById.get(originalCatalogId);
    const prescribedComposition = prescribedCatalog.composition_id == null
      ? null
      : compositionById.get(Number(prescribedCatalog.composition_id));
    const currentCatalog = catalogById.get(currentCatalogId);
    const currentComposition = currentCatalog.composition_id == null
      ? null
      : compositionById.get(Number(currentCatalog.composition_id));
    return {
      order_line_index: orderLineIndex,
      prescribed: stableCatalogAuthorityProjection(prescribedCatalog, prescribedComposition),
      current: stableCatalogAuthorityProjection(currentCatalog, currentComposition),
      substitution_applied: originalCatalogId !== currentCatalogId,
      medication: {
        catalog_id: originalCatalogId,
        name: prescribedCatalog.name,
        dose: item?.dose ?? item?.dosage ?? item?.strength ?? prescribedCatalog.strength ?? null,
        frequency: item?.frequency ?? item?.freq ?? null,
        route: item?.route ?? prescribedCatalog.route ?? null,
        days: item?.days ?? item?.duration_days ?? item?.duration ?? null,
      },
    };
  });
  return {
    sha256: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
    medications: projection.map((entry) => entry.medication),
  };
}

export async function clinicalCatalogAuthoritySha256Tx(tx, { tenantId, itemsList }) {
  const authority = await resolveClinicalCatalogAuthority(
    tx,
    requireTenantId(tenantId),
    itemsList,
    { forUpdate: true },
  );
  return authority.sha256;
}

export function orderItemsToMedications(itemsList) {
  if (!Array.isArray(itemsList)) return [];
  return itemsList
    .map((item) => ({
      catalog_id: Number(item?.catalog_id) || null,
      name: item?.name || item?.medication_name || item?.item_name || null,
      dose: item?.dose || item?.dosage || item?.strength || null,
      frequency: item?.frequency || item?.freq || null,
      route: item?.route || null,
      days: item?.days || item?.duration_days || null,
    }))
    .filter((m) => m.name);
}

export function clinicalOrderItemsSha256(itemsList) {
  const clinicalProjection = (Array.isArray(itemsList) ? itemsList : []).map((item, index) => ({
    order_line_index: Number(item?.order_line_index ?? index),
    prescription_line_index: item?.prescription_line_index == null
      ? null
      : Number(item.prescription_line_index),
    prescribed_catalog_id: Number(
      item?.substitution_history?.[0]?.original_catalog_id ?? item?.catalog_id ?? 0,
    ) || null,
    ordered_quantity: Number(
      item?.ordered_qty ?? item?.prescribed_qty ?? item?.quantity ?? item?.qty ?? 0,
    ) || null,
    name: item?.substitution_history?.[0]?.original_name
      ?? item?.name ?? item?.medication_name ?? item?.item_name ?? null,
    dose: item?.dose ?? item?.dosage ?? item?.strength ?? null,
    frequency: item?.frequency ?? item?.freq ?? null,
    route: item?.route ?? null,
    duration: item?.days ?? item?.duration_days ?? item?.duration ?? null,
    instructions: item?.instructions ?? item?.label_instruction ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(clinicalProjection)).digest('hex');
}

async function loadOrder(orderId, tenantId, db = prisma, { forUpdate = false } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await db.$queryRawUnsafe(
    `SELECT po.id, po.order_number, po.status, po.delivery_type, po.patient_id, po.patient_name,
            po.items_list, po.tenant_id, po.facility_id, po.total_amount,
            po.authority_origin,
            po.clinical_verification_status, po.clinically_verified_by,
            po.assigned_pharmacist,
            po.clinically_verified_at, po.clinical_verification_notes, po.pack_barcode,
            po.inventory_authority_version, po.clinically_verified_order_version,
            po.clinical_verification_items_sha256,
            po.clinical_verification_catalog_sha256,
            po.clinical_verification_active_therapy_sha256,
            po.clinical_verification_safety_version,
            po.clinical_verification_kb_version,
            po.clinical_verification_ruleset_version,
            u.uid AS patient_uid
       FROM pharmacy_orders po
       JOIN facilities facility
         ON facility.tenant_id=po.tenant_id
        AND facility.id=po.facility_id
        AND facility.status='active'
       LEFT JOIN users u
         ON u.id = po.patient_id
        AND u.tenant_id = po.tenant_id
        AND u.role = 'PATIENT'
        AND u.is_active=TRUE
        AND u.status='active'
        AND u.is_deleted=FALSE
        AND u.merged_into_uid IS NULL
      WHERE po.id = $1
        AND po.tenant_id = $2::uuid
        AND (po.patient_id IS NULL OR u.uid IS NOT NULL)
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF po, facility' : ''}`,
    orderId,
    tid,
  );
  return rows[0] || null;
}

function assertClearedStatus(orderId, rawStatus) {
  const status = rawStatus || CLINICAL_VERIFICATION_STATUS.PENDING;
  if (!VERIFICATION_CLEARED_STATUSES.includes(status)) {
    throw AppError.conflict(
      status === CLINICAL_VERIFICATION_STATUS.REJECTED
        ? 'Order was rejected at pharmacist clinical verification — it cannot progress'
        : 'Pharmacist clinical verification is required before this order can progress',
      'PHARMACY_VERIFICATION_REQUIRED',
      { clinical_verification_status: status, verify_endpoint: `/api/v1/pharmacy/orders/${orderId}/verify` },
    );
  }
  return { enforced: true, status };
}

async function assertVerificationClearedWithDb(db, orderId, tenantId, { forUpdate = false } = {}) {
  const tid = requireTenantId(tenantId);
  await lockTenantPatientMergeStability(db, tid);
  await lockPharmacyCatalogAuthorityTx(db, tid);
  const order = await loadOrder(orderId, tid, db, { forUpdate });
  if (!order) throw AppError.notFound('Pharmacy order not found');
  if (!BCMA_CONFIG.requirePharmacistVerification) {
    return {
      enforced: false,
      delivery_type: order.delivery_type,
      order_status: order.status,
    };
  }
  const expectedPatientId = order.patient_id;
  const linkedPrescriptions = await db.$queryRawUnsafe(
      `SELECT id, patient_id, patient_uid
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        ORDER BY id
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      tid,
      orderId,
  );
  const linkedAuthorityInvalid = order.authority_origin === 'e_prescription'
    ? (linkedPrescriptions.length !== 1
      || order.patient_id == null
      || !order.patient_uid
      || Number(linkedPrescriptions[0]?.patient_id) !== Number(order.patient_id)
      || String(linkedPrescriptions[0]?.patient_uid || '') !== String(order.patient_uid))
    : (order.authority_origin === 'patient_manual'
      ? linkedPrescriptions.length !== 0
      : true);
  if (linkedAuthorityInvalid) {
    throw AppError.conflict(
      'The linked prescription no longer resolves to the order patient authority',
      'PHARMACY_VERIFICATION_PRESCRIPTION_AUTHORITY_STALE',
      { verify_endpoint: `/api/v1/pharmacy/orders/${orderId}/verify` },
    );
  }
  const currentKnowledgeRevision = await loadDrugKbRevision(db, { forUpdate });
  if (!currentKnowledgeRevision) {
    throw AppError.conflict(
      'The authoritative medication knowledge revision is unavailable',
      'PHARMACY_VERIFY_KB_UNAVAILABLE',
    );
  }
  let currentSafetyVersion = null;
  if (expectedPatientId != null) {
    if (forUpdate) {
      currentSafetyVersion = await lockPatientSafetyVersionTx(db, tid, expectedPatientId);
    } else {
      const safetyRows = await db.$queryRawUnsafe(
        `SELECT version
           FROM pharmacy_patient_safety_versions
          WHERE tenant_id=$1::uuid AND patient_id=$2::int`,
        tid,
        Number(expectedPatientId),
      );
      currentSafetyVersion = Number(safetyRows[0]?.version ?? 1);
    }
  }
  const cleared = assertClearedStatus(orderId, order.clinical_verification_status);
  const currentHash = clinicalOrderItemsSha256(order.items_list);
  const catalogAuthority = await resolveClinicalCatalogAuthority(
    db,
    tid,
    order.items_list,
    { forUpdate },
  );
  let activeTherapy = { sha256: null, blockers: [] };
  if (expectedPatientId != null) {
    try {
      activeTherapy = await loadActiveTherapySnapshot(expectedPatientId, {
        tenantId: tid,
        db,
        excludePrescriptionId: linkedPrescriptions[0]?.id || null,
        excludePharmacyOrderId: order.id,
      });
    } catch (err) {
      logger.error('Active-therapy authority recomputation failed:', err.message);
      throw AppError.conflict(
        'The patient active-therapy authority could not be recomputed',
        'PHARMACY_VERIFY_ACTIVE_THERAPY_CONTEXT_UNAVAILABLE',
      );
    }
    if (activeTherapy.blockers.length > 0) {
      throw AppError.conflict(
        'The patient active-therapy authority requires medication reconciliation',
        'PHARMACY_VERIFY_ACTIVE_THERAPY_RECONCILIATION_REQUIRED',
        { blockers: activeTherapy.blockers },
      );
    }
  }
  if (Number(order.clinically_verified_order_version)
      !== Number(order.inventory_authority_version)
    || order.clinical_verification_items_sha256 !== currentHash
    || order.clinical_verification_catalog_sha256 !== catalogAuthority.sha256
    || order.clinical_verification_active_therapy_sha256 !== activeTherapy.sha256
    || Number(order.clinical_verification_kb_version) !== currentKnowledgeRevision
    || Number(order.clinical_verification_ruleset_version) !== CLINICAL_RULESET_VERSION
    || (order.patient_id != null
      && (order.clinical_verification_safety_version == null
        || Number(order.clinical_verification_safety_version) !== currentSafetyVersion))) {
    throw AppError.conflict(
      'Pharmacy order, medication catalog, or patient safety context changed after verification; re-verify the current authority',
      'PHARMACY_VERIFICATION_STALE',
      { verify_endpoint: `/api/v1/pharmacy/orders/${orderId}/verify` },
    );
  }
  return {
    ...cleared,
    delivery_type: order.delivery_type,
    items_sha256: currentHash,
    catalog_sha256: catalogAuthority.sha256,
    active_therapy_sha256: activeTherapy.sha256,
    knowledge_revision: currentKnowledgeRevision,
    medications: catalogAuthority.medications,
  };
}

async function lockPatientSafetyVersionTx(tx, tenantId, patientId) {
  if (!patientId) return null;
  await tx.$executeRawUnsafe(
    `INSERT INTO pharmacy_patient_safety_versions (tenant_id, patient_id, version, updated_at)
     VALUES ($1::uuid, $2::int, 1, NOW())
     ON CONFLICT (tenant_id, patient_id) DO NOTHING`,
    tenantId,
    Number(patientId),
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT version
       FROM pharmacy_patient_safety_versions
      WHERE tenant_id=$1::uuid AND patient_id=$2::int
      FOR UPDATE`,
    tenantId,
    Number(patientId),
  );
  if (!rows.length) {
    throw AppError.conflict(
      'Patient medication-safety context could not be locked',
      'PHARMACY_VERIFY_SAFETY_CONTEXT_UNAVAILABLE',
    );
  }
  return Number(rows[0].version);
}

/**
 * Gate helper for lifecycle controllers: throws 409 when the order has not
 * cleared pharmacist clinical verification (and enforcement is on).
 */
export async function assertVerificationCleared(orderId, tenantId) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => assertVerificationClearedWithDb(tx, orderId, tid));
}

export async function assertVerificationClearedTx(tx, { orderId, tenantId }) {
  return assertVerificationClearedWithDb(tx, orderId, tenantId, { forUpdate: true });
}

/**
 * Run pharmacist clinical verification on a pharmacy order.
 *
 * decision:
 *   'verified' — only allowed when the safety engine reports no blockers.
 *   'override' — blockers acknowledged; requires overrideReason (≥10 chars).
 *   'rejected' — pharmacist refuses the order (sends it back to prescriber).
 */
export async function verifyOrder(orderId, {
  tenantId,
  decision = CLINICAL_VERIFICATION_STATUS.VERIFIED,
  overrideReason = null,
  rejectionReason = null,
  manualAllergyReviewCompleted = false,
  notes = null,
  actorUid = null,
  actorRole = null,
  commandKeySha256,
  requestSha256,
} = {}) {
  const tid = requireTenantId(tenantId);
  const normalizedActorRole = String(actorRole || '').trim().toUpperCase();
  if (!CLINICAL_VERIFIER_ROLES.has(normalizedActorRole)) {
    throw AppError.forbidden(
      'Only an assigned pharmacist may clinically verify, reject, or override a pharmacy order',
      'PHARMACY_VERIFY_ROLE_FORBIDDEN',
      { allowed_roles: [...CLINICAL_VERIFIER_ROLES] },
    );
  }
  if (decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE
    && !CLINICAL_OVERRIDE_ROLES.has(normalizedActorRole)) {
    throw AppError.forbidden(
      'Clinical safety override requires pharmacy-incharge break-glass authority',
      'PHARMACY_VERIFY_OVERRIDE_FORBIDDEN',
      { allowed_roles: [...CLINICAL_OVERRIDE_ROLES] },
    );
  }
  if (!Object.values(CLINICAL_VERIFICATION_STATUS).includes(decision)
    || decision === CLINICAL_VERIFICATION_STATUS.PENDING) {
    throw AppError.badRequest('decision must be verified|override|rejected', 'PHARMACY_VERIFY_BAD_DECISION');
  }
  const trimmedReason = (overrideReason || '').trim();
  const trimmedRejectionReason = (rejectionReason || notes || '').trim();
  if (decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE && trimmedReason.length < MIN_OVERRIDE_REASON_LENGTH) {
    throw AppError.badRequest(
      `override requires a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters`,
      'PHARMACY_VERIFY_OVERRIDE_REASON_REQUIRED',
    );
  }
  if (decision === CLINICAL_VERIFICATION_STATUS.REJECTED
    && (trimmedRejectionReason.length < MIN_OVERRIDE_REASON_LENGTH
      || trimmedRejectionReason.length > 500)) {
    throw AppError.badRequest(
      `rejection_reason must contain ${MIN_OVERRIDE_REASON_LENGTH} to 500 characters`,
      'PHARMACY_VERIFY_REJECTION_REASON_REQUIRED',
    );
  }
  if (!actorUid || !commandKeySha256 || !requestSha256) {
    throw AppError.forbidden(
      'Clinical verification requires an authenticated pharmacist and durable command identity',
      'PHARMACY_VERIFY_ACTOR_IDENTITY_REQUIRED',
    );
  }

  const outcome = await setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    await lockPharmacyCatalogAuthorityTx(tx, tid);
    const actors = await tx.$queryRawUnsafe(
      `SELECT id, uid, role
         FROM users
         WHERE tenant_id=$1::uuid AND uid=$2::uuid
           AND role=ANY($3::text[])
           AND is_active=TRUE AND status='active'
           AND is_deleted=FALSE AND merged_into_uid IS NULL
         LIMIT 1
         FOR UPDATE`,
      tid,
      actorUid,
      [...CLINICAL_VERIFIER_ROLES],
    );
    if (!actors[0] || String(actors[0].role).toUpperCase() !== normalizedActorRole) {
      throw AppError.forbidden(
        'The authenticated clinician has no active same-tenant pharmacist authority',
        'PHARMACY_VERIFY_ACTOR_IDENTITY_REQUIRED',
      );
    }
    const order = await loadOrder(orderId, tid, tx, { forUpdate: true });
    if (!order) throw AppError.notFound('Pharmacy order not found');
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: order.facility_id,
      actorUid,
      actorRole: normalizedActorRole,
      forUpdate: true,
    });
    const linkedPrescriptionPatients = await tx.$queryRawUnsafe(
      `SELECT ep.id, ep.patient_id, ep.patient_uid
         FROM e_prescriptions ep
        WHERE ep.tenant_id=$1::uuid AND ep.pharmacy_order_id=$2::int
        ORDER BY ep.id
        FOR UPDATE OF ep`,
      tid,
      orderId,
    );
    const linkCountInvalid = order.authority_origin === 'e_prescription'
      ? linkedPrescriptionPatients.length !== 1
      : (order.authority_origin === 'patient_manual'
        ? linkedPrescriptionPatients.length !== 0
        : true);
    if (linkCountInvalid) {
      throw AppError.conflict(
        'Pharmacy order prescription linkage does not match its durable origin',
        'PHARMACY_ORDER_PRESCRIPTION_ORIGIN_MISMATCH',
      );
    }
    const activePatientRows = order.patient_id == null
      ? []
      : await tx.$queryRawUnsafe(
        `SELECT uid
           FROM users
          WHERE tenant_id=$1::uuid AND id=$2::int
            AND role='PATIENT' AND is_active=TRUE AND status='active'
            AND is_deleted=FALSE AND merged_into_uid IS NULL
          LIMIT 1
          FOR UPDATE`,
        tid,
        Number(order.patient_id),
      );
    const activePatientUid = activePatientRows[0]?.uid || null;
    if (order.patient_id != null
      && (!activePatientUid || String(order.patient_uid || '') !== String(activePatientUid))) {
      throw AppError.conflict(
        'The pharmacy order patient authority is no longer active',
        'PHARMACY_ORDER_PATIENT_AUTHORITY_CHANGED',
      );
    }
    if (linkedPrescriptionPatients.length === 1) {
      const linked = linkedPrescriptionPatients[0];
      if (order.patient_id == null
        || linked.patient_id == null
        || Number(linked.patient_id) !== Number(order.patient_id)
        || !activePatientUid
        || String(linked.patient_uid || '') !== String(activePatientUid)) {
        throw AppError.conflict(
          'The linked prescription patient does not match the pharmacy order patient',
          'PHARMACY_ORDER_PRESCRIPTION_PATIENT_MISMATCH',
        );
      }
    }
    const receipt = await loadPharmacyOrderCommandReceiptTx(tx, {
      tenantId: tid,
      orderId,
      action: 'verify',
      commandKeySha256,
      requestSha256,
    });
    if (receipt) return { replay: true, result: receipt.payload };
    const knowledgeRevision = await loadDrugKbRevision(tx, { forUpdate: true });
    if (!knowledgeRevision) {
      throw AppError.conflict(
        'The authoritative medication knowledge revision is unavailable',
        'PHARMACY_VERIFY_KB_UNAVAILABLE',
      );
    }
    const safetyVersion = await lockPatientSafetyVersionTx(tx, tid, order.patient_id);
    const legacyProvenanceRecovery = LEGACY_REVERIFIABLE_ORDER_STATUSES.includes(order.status)
      && (order.clinically_verified_order_version == null
        || order.clinical_verification_items_sha256 == null
        || order.clinical_verification_catalog_sha256 == null
        || (order.patient_id != null
          && order.clinical_verification_active_therapy_sha256 == null)
        || order.clinical_verification_kb_version == null
        || order.clinical_verification_ruleset_version == null
        || (order.patient_id != null && order.clinical_verification_safety_version == null));
    const amendedRejectionRecovery = order.status === 'ON_HOLD'
      && order.clinical_verification_status === CLINICAL_VERIFICATION_STATUS.REJECTED
      && Number(order.inventory_authority_version) !== Number(order.clinically_verified_order_version);
    if (!VERIFIABLE_ORDER_STATUSES.includes(order.status)
      && !legacyProvenanceRecovery
      && !amendedRejectionRecovery) {
      throw AppError.conflict(
        `Order is ${order.status} — clinical verification happens before preparation/dispense`,
        'PHARMACY_VERIFY_WRONG_STATUS',
        { status: order.status },
      );
    }
    const catalogAuthority = await resolveClinicalCatalogAuthority(
      tx,
      tid,
      order.items_list,
      { forUpdate: true },
    );
    const medications = catalogAuthority.medications;
    const itemsSha256 = clinicalOrderItemsSha256(order.items_list);
    if (medications.length === 0) {
      throw AppError.conflict(
        'Order has no structured item list yet — confirm the order (capturing items) before verification',
        'PHARMACY_VERIFY_NO_ITEMS',
      );
    }

    const patientContext = Boolean(order.patient_id);
    let safety;
    if (patientContext) {
      safety = await validatePrescriptionSafety(order.patient_id, medications, {
        tenantId: tid,
        knowledgeRevision,
        db: tx,
        excludePrescriptionId: linkedPrescriptionPatients[0]?.id || null,
        excludePharmacyOrderId: order.id,
        requireActiveTherapyAuthority: true,
      });
    } else {
      const kb = await evaluateDrugKb({ medications, knowledgeRevision, db: tx });
      safety = {
        safe: kb.kbAvailable === true
          && !kb.findings.some((f) => ['contraindicated', 'major', 'high'].includes(f.severity)),
        warnings: kb.findings.filter((f) => !['contraindicated', 'major', 'high'].includes(f.severity))
          .map((f) => ({ type: 'DRUG_KB_FINDING', severity: String(f.severity).toUpperCase(), message: f.message })),
        blockers: kb.findings.filter((f) => ['contraindicated', 'major', 'high'].includes(f.severity))
          .map((f) => ({ type: 'DRUG_KB_FINDING', severity: String(f.severity).toUpperCase(), message: f.message })),
      };
      if (kb.kbAvailable !== true) {
        safety.blockers.push({
          type: 'DRUG_KB_UNAVAILABLE',
          severity: 'HIGH',
          message: 'The authoritative medication knowledge base is unavailable.',
        });
      }
      safety.safe = false;
      safety.blockers.push({
        type: 'SAFETY_CONTEXT_UNAVAILABLE',
        severity: 'HIGH',
        message: 'Registered patient allergy, condition, pregnancy, and dosing context is unavailable.',
        unavailable_sources: ['patient_identity', 'allergies', 'conditions', 'pregnancy', 'weight'],
      });
    }
    if (decision === CLINICAL_VERIFICATION_STATUS.VERIFIED && safety.blockers.length > 0) {
      throw AppError.conflict(
        `Safety engine reports ${safety.blockers.length} blocker(s) — verify is not allowed; use decision=override with a reason, or reject`,
        'PHARMACY_VERIFY_BLOCKERS_PRESENT',
        { blockers: safety.blockers, warnings: safety.warnings },
      );
    }
    const unreconciledActiveTherapy = requiresActiveTherapyReconciliation(safety.blockers);
    if (decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE && unreconciledActiveTherapy) {
      throw AppError.conflict(
        'Active-therapy source, timing, catalog, composition, and knowledge identity must be reconciled before verification or override',
        'PHARMACY_VERIFY_ACTIVE_THERAPY_RECONCILIATION_REQUIRED',
        { blockers: safety.blockers },
      );
    }
    if (decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE
      && safety.blockers.some((blocker) => blocker.type === 'SAFETY_CONTEXT_UNAVAILABLE')
      && manualAllergyReviewCompleted !== true) {
      throw AppError.conflict(
        'A documented manual allergy review is required before overriding unavailable safety context',
        'PHARMACY_VERIFY_MANUAL_ALLERGY_REVIEW_REQUIRED',
        { manual_allergy_review_required: true },
      );
    }
    const findings = [
      ...safety.blockers.map((b) => ({ ...b, disposition: 'blocker' })),
      ...safety.warnings.map((w) => ({ ...w, disposition: 'warning' })),
    ];
    const manualAllergyReviewEvidence = manualAllergyReviewCompleted === true
      ? {
        completed: true,
        reviewed_by: actorUid,
        reviewed_at: new Date().toISOString(),
        unavailable_sources: safety.blockers
          .filter((blocker) => blocker.type === 'SAFETY_CONTEXT_UNAVAILABLE')
          .flatMap((blocker) => blocker.unavailable_sources || blocker.sources || []),
      }
      : null;
    const nextOrderStatus = decision === CLINICAL_VERIFICATION_STATUS.REJECTED
      ? 'ON_HOLD'
      : (amendedRejectionRecovery ? 'CONFIRMED' : order.status);
    const allowedOrderStatuses = amendedRejectionRecovery
      ? ['ON_HOLD']
      : (legacyProvenanceRecovery
        ? [...VERIFIABLE_ORDER_STATUSES, ...LEGACY_REVERIFIABLE_ORDER_STATUSES]
        : VERIFIABLE_ORDER_STATUSES);

    const rows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_orders SET
         status = $16,
         assigned_pharmacist = COALESCE(assigned_pharmacist, $3::uuid),
         clinical_verification_status = $2,
         clinically_verified_by = $3::uuid,
         clinically_verified_at = NOW(),
         clinical_verification_notes = $4,
         clinical_verification_findings = $5::jsonb,
         clinically_verified_order_version = $6::int,
         clinical_verification_items_sha256 = $7,
         clinical_verification_catalog_sha256 = $13,
         clinical_verification_active_therapy_sha256 = $17,
         clinical_verification_safety_version = $12::bigint,
         clinical_verification_kb_version = $14::bigint,
         clinical_verification_ruleset_version = $15::int,
         updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $8::uuid
         AND facility_id = $11::int
         AND status = ANY($9::text[])
         AND inventory_authority_version = $6::int
         AND items_list IS NOT DISTINCT FROM $10::jsonb
         AND (assigned_pharmacist IS NULL OR assigned_pharmacist=$3::uuid)
       RETURNING id, order_number, status, patient_id, patient_name, tenant_id,
                 clinical_verification_status, clinically_verified_by,
                 clinically_verified_at, clinical_verification_notes, pack_barcode`,
      orderId,
      decision,
      actorUid,
      [notes,
        decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE ? `OVERRIDE: ${trimmedReason}` : null,
        decision === CLINICAL_VERIFICATION_STATUS.REJECTED
          ? `REJECTED: ${trimmedRejectionReason}` : null]
        .filter(Boolean).join(' | ') || null,
      JSON.stringify({
        patient_context: patientContext,
        blockers: safety.blockers,
        warnings: safety.warnings,
        decided_at: new Date().toISOString(),
        inventory_authority_version: Number(order.inventory_authority_version),
        clinical_items_sha256: itemsSha256,
        clinical_catalog_sha256: catalogAuthority.sha256,
        clinical_kb_version: knowledgeRevision,
        clinical_ruleset_version: CLINICAL_RULESET_VERSION,
        legacy_provenance_recovery: legacyProvenanceRecovery,
        manual_allergy_review_completed: manualAllergyReviewCompleted === true,
        manual_allergy_review_evidence: manualAllergyReviewEvidence,
        active_therapy_evidence: safety.active_therapy_evidence || [],
        active_therapy_sha256: safety.active_therapy_sha256 || null,
        rejection_reason: decision === CLINICAL_VERIFICATION_STATUS.REJECTED
          ? trimmedRejectionReason : null,
      }),
      Number(order.inventory_authority_version),
      itemsSha256,
      tid,
      allowedOrderStatuses,
      JSON.stringify(order.items_list),
      Number(order.facility_id),
      safetyVersion,
      catalogAuthority.sha256,
      knowledgeRevision,
      CLINICAL_RULESET_VERSION,
      nextOrderStatus,
      safety.active_therapy_sha256 || null,
    );
    const row = rows[0];
    if (!row) {
      throw AppError.conflict(
        'Pharmacy order changed before clinical verification could be recorded',
        'PHARMACY_VERIFY_STATE_CHANGED',
      );
    }
    if (nextOrderStatus !== order.status) {
      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, $3, $4, $5::int, $6, $7)`,
        tid,
        orderId,
        order.status,
        nextOrderStatus,
        actors[0]?.id || null,
        normalizedActorRole,
        decision === CLINICAL_VERIFICATION_STATUS.REJECTED
          ? trimmedRejectionReason : 'Amended order cleared after pharmacist rejection',
      );
    }

    if (order.patient_uid && (findings.length > 0 || decision !== CLINICAL_VERIFICATION_STATUS.VERIFIED)) {
      // recordMedicationSafetyReviews consumes the { blockers, warnings }
      // shape directly (one review row per issue; blocked rows flip to
      // 'overridden' when an override reason is supplied).
      await recordMedicationSafetyReviews({
        tenantId: tid,
        patientUid: order.patient_uid,
        patientId: order.patient_id,
        safety: { safe: safety.safe, blockers: safety.blockers, warnings: safety.warnings },
        override: decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE
          ? { reason: trimmedReason, approvedBy: actorUid }
          : null,
        actorUid,
      }, { db: tx });
    }

    const eventType = decision === CLINICAL_VERIFICATION_STATUS.VERIFIED ? 'pharmacy.order_clinically_verified'
      : decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE ? 'pharmacy.order_verification_override'
        : 'pharmacy.order_verification_rejected';
    if (order.patient_uid) {
      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: order.patient_uid,
        eventType,
        eventStatus: decision,
        sourceTable: 'pharmacy_orders',
        sourceId: String(orderId),
        resourceType: 'pharmacy_order',
        resourceId: String(orderId),
        actorUid,
        actorRole,
        summary: `Pharmacist verification ${decision} for order ${order.order_number || orderId}` +
          (safety.blockers.length ? ` (${safety.blockers.length} blocker(s))` : ''),
        payload: {
          order_id: orderId,
          order_number: order.order_number || null,
          decision,
          blocker_count: safety.blockers.length,
          warning_count: safety.warnings.length,
          override_reason: decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE ? trimmedReason : null,
          medication_names: medications.map((m) => m.name),
          clinical_catalog_sha256: catalogAuthority.sha256,
          active_therapy_sha256: safety.active_therapy_sha256 || null,
          clinical_kb_version: knowledgeRevision,
          clinical_ruleset_version: CLINICAL_RULESET_VERSION,
          legacy_provenance_recovery: legacyProvenanceRecovery,
          manual_allergy_review_completed: manualAllergyReviewCompleted === true,
          manual_allergy_review_evidence: manualAllergyReviewEvidence,
          rejection_reason: decision === CLINICAL_VERIFICATION_STATUS.REJECTED
            ? trimmedRejectionReason : null,
        },
        beforeState: { clinical_verification_status: order.clinical_verification_status },
        afterState: { clinical_verification_status: decision },
        tags: ['pharmacy', 'medication', 'verification'],
        timelineIdempotencyKey: `pharmacy_orders:${orderId}:${eventType}:${commandKeySha256}`,
        auditIdempotencyKey: `pharmacy_orders:${orderId}:audit:${eventType}:${commandKeySha256}`,
      }, { db: tx });
    }
    const responsePayload = {
      order: row,
      safety: {
        safe: safety.safe,
        blockers: safety.blockers,
        warnings: safety.warnings,
        active_therapy_sha256: safety.active_therapy_sha256 || null,
      },
      patient_context: patientContext,
    };
    await storePharmacyOrderCommandReceiptTx(tx, {
      tenantId: tid,
      orderId,
      action: 'verify',
      commandKeySha256,
      requestSha256,
      payload: responsePayload,
      message: `Order verification ${row.clinical_verification_status}`,
    });
    return { replay: false, result: responsePayload, safety };
  }, { isolationLevel: 'Serializable', timeout: 30000 });

  logger.info('Pharmacist clinical verification recorded', {
    order_id: orderId,
    decision,
    blockers: outcome.safety?.blockers?.length ?? outcome.result.safety.blockers.length,
    warnings: outcome.safety?.warnings?.length ?? outcome.result.safety.warnings.length,
    replay: outcome.replay,
  });
  return outcome.result;
}

/** Generate (idempotently) the platform med-pack barcode for an order. */
export async function ensurePackBarcode(orderId, tenantId) {
  const tid = requireTenantId(tenantId);
  const token = randomBytes(4).toString('hex').toUpperCase();
  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `UPDATE pharmacy_orders
        SET pack_barcode = COALESCE(pack_barcode, $2),
            updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $3::uuid
        AND EXISTS (
          SELECT 1 FROM facilities facility
           WHERE facility.tenant_id=$3::uuid
             AND facility.id=pharmacy_orders.facility_id
             AND facility.status='active'
        )
      RETURNING id, pack_barcode`,
    orderId,
    `VHMP-${orderId}-${token}`,
    tid,
  ));
  if (!rows.length) throw AppError.notFound('Pharmacy order not found');
  return rows[0].pack_barcode;
}

/**
 * Printable med-pack label payload. Requires cleared verification when
 * enforcement is on (a pack label is the artefact of a verified dispense).
 */
export async function getPackLabel(orderId, tenantId) {
  const tid = requireTenantId(tenantId);
  const order = await setTenantTx(tid, async (tx) => {
    const verification = await assertVerificationClearedWithDb(
      tx,
      orderId,
      tid,
      { forUpdate: true },
    );
    const locked = await loadOrder(orderId, tid, tx);
    if (!locked) throw AppError.notFound('Pharmacy order not found');
    if (!locked.pack_barcode) {
      const token = randomBytes(4).toString('hex').toUpperCase();
      const rows = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET pack_barcode=$2, updated_at=NOW()
          WHERE id=$1 AND tenant_id=$3::uuid AND facility_id=$4::int
          RETURNING pack_barcode`,
        orderId,
        `VHMP-${orderId}-${token}`,
        tid,
        Number(locked.facility_id),
      );
      if (!rows.length) throw AppError.notFound('Pharmacy order not found');
      locked.pack_barcode = rows[0].pack_barcode;
    }
    return { ...locked, verified_medications: verification.medications };
  });
  if (!order) throw AppError.notFound('Pharmacy order not found');
  if (BCMA_CONFIG.requirePharmacistVerification
    && !VERIFICATION_CLEARED_STATUSES.includes(order.clinical_verification_status)) {
    throw AppError.conflict(
      'Pharmacist clinical verification is required before printing the pack label',
      'PHARMACY_VERIFICATION_REQUIRED',
      { clinical_verification_status: order.clinical_verification_status },
    );
  }
  const packBarcode = order.pack_barcode;
  return {
    order_id: order.id,
    order_number: order.order_number || null,
    pack_barcode: packBarcode,
    patient: {
      id: order.patient_id || null,
      uid: order.patient_uid || null,
      name: order.patient_name || null,
    },
    items: order.verified_medications,
    verification: {
      status: order.clinical_verification_status,
      verified_by: order.clinically_verified_by || null,
      verified_at: order.clinically_verified_at || null,
    },
    generated_at: new Date().toISOString(),
  };
}

export default {
  verifyOrder,
  assertVerificationCleared,
  assertVerificationClearedTx,
  ensurePackBarcode,
  getPackLabel,
  orderItemsToMedications,
};
