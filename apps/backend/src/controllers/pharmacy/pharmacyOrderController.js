// src/controllers/pharmacy/pharmacyOrderController.js
// Full pharmacy order lifecycle: PENDING → CONFIRMED → PREPARING → DISPATCHED → DELIVERED

import { createHash, randomBytes } from 'node:crypto';

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { screenUploadBuffer } from '../../services/security/fileScanService.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { stripHtml } from '../../utils/sanitize.js';
import { logAudit } from '../../utils/logAudit.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import { calculateETA } from '../delivery/deliveryTrackingController.js';
import {
  assertPharmacyCapForDispenseTx,
  lockPharmacyFundingAuthorityTx,
  resolveAuthoritativeCounterFundingTx,
  resolvePharmacyFundingPatientUidTx,
} from '../../services/pharmacy/pharmacyCapService.js';
import { requireTenantId } from '../../services/tenant/tenantService.js';
import {
  assertPharmacyFacilityGrant,
  pharmacyFacilityActorFromRequest,
  requestedPharmacyFacilityId,
  resolveOrderPharmacyFacility,
  resolvePharmacyFacility,
} from '../../services/pharmacy/pharmacyFacilityAuthorityService.js';
import { getUnifiedActiveAllergiesDetailed } from '../../services/clinical/allergySourceService.js';
import { emitPharmacyOrderEvent } from '../../services/clinical/canonicalOperationalBridgeService.js';
import {
  assertVerificationClearedTx,
  clinicalOrderItemsSha256,
  lockPharmacyCatalogAuthorityTx,
} from '../../services/pharmacy/pharmacistVerificationService.js';
import {
  compensateTerminalPharmacyFundingAuthorityTx,
  materializePharmacyFundingAuthority,
} from '../../services/billing/billingV2Service.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { isCompositionSearchEnabled } from '../../services/pharmacy/compositionFeatureService.js';
import { resolveCompositionIdentitiesByCatalogIds } from '../../services/pharmacy/compositionIdentityService.js';
import { enrichCatalogRowForWrite } from '../../../scripts/backfill-drug-compositions.mjs';
import {
  allocateOrderInventoryTx,
  applyAuthoritativeDeliveryAllocations,
  applyOrderPrescriptionProjectionTx,
  createDispenseCommandIdentity,
  dispenseSubstitutionCommand,
  resolveCounterDispenseAuthorityTx,
  resolvePrescriptionLineIndexes,
  substitutionWitnessPayload,
} from '../../services/pharmacy/pharmacyOrderInventoryService.js';
import {
  loadPharmacyOrderCommandReceiptTx,
  pharmacyCommandRequestSha256,
  storePharmacyOrderCommandReceiptTx,
} from '../../services/pharmacy/pharmacyOrderCommandReceiptService.js';
import {
  appendPharmacyDeliveryCustodyEventTx,
  pharmacyDeliveryPackageEvidence,
} from '../../services/pharmacy/pharmacyDeliveryCustodyService.js';

// ── Helper: attach signed URL to order ──────────────────────────────────────
async function attachSignedUrl(order) {
  if (order.prescription_photo_key) {
    try {
      order.prescription_photo_url = await getSignedFileUrl(order.prescription_photo_key, 3600);
    } catch (e) { logger.warn('Signed URL generation failed for prescription photo:', e.message); }
  }
  return order;
}

function auditPharmacyOrder(req, action, order, extra = {}) {
  if (!order?.id) return;
  logAudit(
    req,
    action,
    {
      pharmacy_order_id: order.id,
      pharmacy_order_uid: order.uid || null,
      order_number: order.order_number || null,
      patient_id: order.patient_id || null,
      patient_name: order.patient_name || null,
      status: order.status || null,
      ...extra,
    },
    { resource: 'pharmacy_orders', resourceId: order.id },
  ).catch((auditErr) => {
    logger.warn(`Pharmacy audit ${action} failed for order ${order.id}: ${auditErr.message}`);
  });
}

function dispenseCommandKey(req, scope) {
  return createDispenseCommandIdentity({
    tenantId: req.tenantId,
    actorUid: req.user?.uid,
    scope,
    idempotencyKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key'),
  });
}

function pharmacyOrderCommand(req, orderId, action, payload = req.body || {}) {
  return {
    action,
    commandKeySha256: dispenseCommandKey(req, `${action}:${orderId}`),
    requestSha256: pharmacyCommandRequestSha256(payload),
  };
}

// ── Order-id normalisation ──────────────────────────────────────────
// Every :id surface below binds the order id into a `::int` parameter: its own
// raw SQL, findOrderCommandReplay's `pharmacy_order_id=$2::int`
// (pharmacyOrderCommandReceiptService.js) and resolveOrderPharmacyFacility's
// `po.id=$2::int`. An id that is a safe positive integer but above int4 max
// (e.g. 9999999999) therefore reached a bind and raised Postgres 22003
// 'integer out of range' — a plain error carrying no statusCode, which
// errorHandlerMiddleware answers as a bare 500 with no code. The repo names
// this hazard at middleware/routePatientAccessGuards.js:38-40 ("an
// out-of-range value ... must become null, never a 22003 from the bind") and
// applies the same ceiling at routes/pharmacy/orderRoutes.js:156.
//
// ★ The ceiling has to be enforced HERE as well as in
// pharmacyFacilityAuthorityService.positiveId: on every lifecycle handler
// findOrderCommandReplay runs BEFORE resolveOrderPharmacyFacility, so the
// service-side bound alone still leaves the 22003 reachable.
//
// Digit-string first, then Number: it makes the accepted set exactly the
// canonical decimal integers, so the `Number(id)` handed to the facility
// service and the `parseInt(id)` bound into the raw SQL of the same handler
// can never disagree (they do for '1e3' — Number 1000 vs parseInt 1).
const PG_INT4_MAX = 2147483647;

function pharmacyOrderIdOrNull(value) {
  const text = value == null ? '' : String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= PG_INT4_MAX
    ? parsed
    : null;
}

function requirePharmacyOrderId(value) {
  const parsed = pharmacyOrderIdOrNull(value);
  if (!parsed) {
    throw AppError.badRequest('Invalid order id', 'PHARMACY_ORDER_ID_INVALID');
  }
  return parsed;
}

// ★ 404-vs-409 on an unknown order id: every :id lifecycle handler below
// consults facility custody (resolveOrderPharmacyFacility) BEFORE it reaches
// its own not-found branch, and that service used to answer 409
// PHARMACY_ORDER_FACILITY_UNRESOLVED for an id naming no row — so the 404
// branches here were unreachable. The classification is fixed at the root, in
// pharmacyFacilityAuthorityService.resolveOrderPharmacyFacility, which now
// probes order existence on its MISS path only: a missing order raises the
// same AppError.notFound('Order not found') these handlers raise, and a real
// order whose custody is genuinely unresolved still raises the 409. Do not
// re-add a duplicate existence probe here.

async function lockOrderFundingAuthorityTx(tx, {
  tenantId,
  orderId = null,
  patientId = null,
  patientUid = null,
}) {
  const canonicalPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId,
    orderId,
    patientId,
    patientUid,
  });
  await lockPharmacyFundingAuthorityTx(tx, {
    tenantId,
    patientUid: canonicalPatientUid,
  });
  return canonicalPatientUid;
}

function counterDispenseCommandPayload(req) {
  const payload = { ...(req.body || {}) };
  delete payload.order_id;
  delete payload.orderId;
  delete payload.id;
  return payload;
}

async function loadOrderCommandReplayTx(tx, req, orderId, command) {
  return loadPharmacyOrderCommandReceiptTx(tx, {
    tenantId: req.tenantId,
    orderId,
    ...command,
  });
}

async function findOrderCommandReplay(req, orderId, command) {
  return setTenantTx(req.tenantId, (tx) => (
    loadOrderCommandReplayTx(tx, req, orderId, command)
  ));
}

async function storeOrderCommandReceiptTx(tx, req, orderId, command, payload, message) {
  await storePharmacyOrderCommandReceiptTx(tx, {
    tenantId: req.tenantId,
    orderId,
    ...command,
    payload,
    message,
  });
  return payload;
}

const PHARMACY_CAP_OVERRIDE_ROLES = new Set(['PHARMACY_INCHARGE']);
const PHARMACY_FACILITY_ASSIGNMENT_ROLES = new Set(['PHARMACY_INCHARGE', 'ADMIN', 'SUPER_ADMIN']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deliveryHandoffSha256(tenantId, orderId, token) {
  return createHash('sha256')
    .update(`${tenantId}:${orderId}:${token}`)
    .digest('hex');
}

function pharmacyCapOverrideAuthority(req, requested, rawReason) {
  if (requested !== true) return null;
  const actorRole = String(req.user?.role || req.user?.rawRole || '').trim().toUpperCase();
  if (!PHARMACY_CAP_OVERRIDE_ROLES.has(actorRole)) {
    throw AppError.forbidden(
      'TPA pharmacy-cap override requires pharmacy-incharge authority',
      'TPA_PHARMACY_CAP_OVERRIDE_FORBIDDEN',
    );
  }
  const actorUid = String(req.user?.uid || '').trim();
  if (!actorUid) {
    throw AppError.forbidden(
      'TPA pharmacy-cap override requires an authenticated pharmacy-incharge identity',
      'TPA_PHARMACY_CAP_OVERRIDE_FORBIDDEN',
    );
  }
  const reason = String(rawReason || '').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw AppError.badRequest(
      'cap_override_reason must contain 10 to 500 characters',
      'TPA_PHARMACY_CAP_OVERRIDE_REASON_REQUIRED',
    );
  }
  return {
    authorised_by: actorUid,
    authorised_role: actorRole,
    justification: reason,
  };
}

function capOverrideHistoryNote(capOverride) {
  if (!capOverride) return null;
  return `TPA pharmacy-cap override by ${capOverride.authorised_role} `
    + `${capOverride.authorised_by}: ${capOverride.justification}`;
}

function positiveQuantity(value, label = 'quantity') {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw AppError.badRequest(`${label} must be greater than 0`, 'PHARMACY_DISPENSE_QUANTITY_INVALID');
  }
  return quantity;
}

const SUBSTITUTION_MAX_SCALED_QUANTITY = 99_999_999_999_999n;

export function canonicalSubstitutionQuantity(value) {
  if (value == null || ['boolean', 'symbol', 'function'].includes(typeof value)) {
    throw AppError.badRequest(
      'quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places',
      'PHARMACY_DISPENSE_QUANTITY_INVALID',
    );
  }
  let quantityText;
  try {
    quantityText = String(value);
  } catch {
    throw AppError.badRequest(
      'quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places',
      'PHARMACY_DISPENSE_QUANTITY_INVALID',
    );
  }
  if (quantityText !== quantityText.trim()) {
    throw AppError.badRequest(
      'quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places',
      'PHARMACY_DISPENSE_QUANTITY_INVALID',
    );
  }
  const match = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,4}))?$/.exec(quantityText);
  const scaledQuantity = match
    ? (BigInt(match[1]) * 10_000n) + BigInt((match[2] || '').padEnd(4, '0'))
    : null;
  if (scaledQuantity == null
      || scaledQuantity <= 0n
      || scaledQuantity > SUBSTITUTION_MAX_SCALED_QUANTITY) {
    throw AppError.badRequest(
      'quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places',
      'PHARMACY_DISPENSE_QUANTITY_INVALID',
    );
  }
  return Number(scaledQuantity) / 10_000;
}

function manualConfirmationLineError(index) {
  return AppError.unprocessable(
    `items_list[${index}] requires stable order_line_index, catalog_id, and positive quantity`,
    'PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED',
    { order_line_index: index, recovery_action: 'select_catalog_item' },
  );
}

export function canonicalManualConfirmationQuantity(value, index) {
  try {
    return canonicalSubstitutionQuantity(value);
  } catch (quantityError) {
    if (quantityError?.code !== 'PHARMACY_DISPENSE_QUANTITY_INVALID') {
      throw quantityError;
    }
    throw manualConfirmationLineError(index);
  }
}

function emitPharmacyOrderEventInTx(tx, req, eventType, order, extra = {}) {
  return emitPharmacyOrderEvent({
    db: tx,
    order: {
      ...order,
      tenant_id: order?.tenant_id || req.tenantId,
    },
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
    eventType,
    eventStatus: extra.to_status || order?.status || null,
    previousStatus: extra.from_status || null,
    payload: extra,
  });
}

async function assertLinkedPrescriptionPatientAuthorityTx(tx, tenantId, orderId) {
  const rawLinks = await tx.$queryRawUnsafe(
    `SELECT ep.id
       FROM e_prescriptions ep
      WHERE ep.tenant_id=$1::uuid AND ep.pharmacy_order_id=$2::int
      ORDER BY ep.id
      FOR UPDATE`,
    tenantId,
    Number(orderId),
  );
  if (!rawLinks.length) return [];
  const validLinks = await tx.$queryRawUnsafe(
    `SELECT ep.id, ep.status, ep.medications,
            COALESCE(ep.revision, 1)::int AS revision
       FROM e_prescriptions ep
       JOIN pharmacy_orders po
         ON po.tenant_id=ep.tenant_id
        AND po.id=ep.pharmacy_order_id
        AND po.patient_id=ep.patient_id
       JOIN users patient
         ON patient.tenant_id=ep.tenant_id
        AND patient.id=ep.patient_id
        AND patient.uid=ep.patient_uid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      WHERE ep.tenant_id=$1::uuid AND ep.pharmacy_order_id=$2::int
      ORDER BY ep.id
      FOR UPDATE OF po, patient`,
    tenantId,
    Number(orderId),
  );
  if (validLinks.length !== rawLinks.length) {
    throw AppError.conflict(
      'The linked prescription does not match the order patient authority',
      'PHARMACY_ORDER_PRESCRIPTION_PATIENT_MISMATCH',
      { recovery_action: 'resolve_prescription_order_patient_authority' },
    );
  }
  return validLinks;
}

async function reopenLinkedPrescriptionRemainderTx(tx, {
  tenantId,
  orderId,
  terminalStatus,
  reason,
  actorUid,
}) {
  const rows = await assertLinkedPrescriptionPatientAuthorityTx(tx, tenantId, orderId);
  if (rows.length > 1) {
    throw AppError.conflict(
      'The terminal pharmacy order is linked to more than one prescription',
      'PHARMACY_ORDER_PRESCRIPTION_LINK_AMBIGUOUS',
    );
  }
  if (!rows.length) return null;
  const medications = (Array.isArray(rows[0].medications) ? rows[0].medications : [])
    .map((medication) => {
      const ordered = Number(medication?.ordered_quantity ?? medication?.quantity ?? medication?.qty);
      const dispensed = Math.max(0, Number(medication?.dispensed_quantity || 0));
      const remaining = Number.isFinite(Number(medication?.remaining_quantity))
        ? Math.max(0, Number(medication.remaining_quantity))
        : Math.max(0, ordered - dispensed);
      return {
        ...medication,
        remaining_quantity: remaining,
        reorderable_after_pharmacy_termination: remaining > 0.000001,
        pharmacy_termination_history: [
          ...(Array.isArray(medication?.pharmacy_termination_history)
            ? medication.pharmacy_termination_history
            : []),
          {
            pharmacy_order_id: orderId,
            terminal_status: terminalStatus,
            reason,
            actor_uid: actorUid,
            terminated_at: new Date().toISOString(),
            dispensed_quantity: dispensed,
            remaining_quantity: remaining,
          },
        ],
      };
    });
  if (!medications.some((medication) => medication.reorderable_after_pharmacy_termination)) {
    throw AppError.conflict(
      'The linked prescription is already fully fulfilled; it cannot be reopened or terminated as unavailable',
      'PHARMACY_ORDER_ALREADY_FULFILLED',
      { next_action: 'complete_delivery_from_existing_inventory_evidence' },
    );
  }
  const updated = await tx.$queryRawUnsafe(
    `UPDATE e_prescriptions
        SET status='active',
            pharmacy_opted=FALSE,
            pharmacy_order_id=NULL,
            medications=$3::jsonb,
            revision=COALESCE(revision, 1)+1,
            updated_at=NOW()
      WHERE id=$1::int AND tenant_id=$2::uuid AND COALESCE(revision, 1)=$4::int
      RETURNING id, status, revision`,
    Number(rows[0].id),
    tenantId,
    JSON.stringify(medications),
    Number(rows[0].revision),
  );
  if (!updated.length) {
    throw AppError.conflict(
      'The linked prescription changed before terminal recovery could be recorded',
      'PHARMACY_ORDER_PRESCRIPTION_STATE_CHANGED',
    );
  }
  return updated[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATIENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

export const placeOrder = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const {
      order_note, delivery_type, delivery_address, delivery_landmark,
      delivery_lat, delivery_lng, delivery_phone
    } = req.body;
    const normalizedDeliveryType = String(delivery_type || 'delivery').trim().toLowerCase();

    if (!req.file && !order_note) {
      return error(res, 'Upload a prescription photo or describe your order', HTTP_STATUS.BAD_REQUEST);
    }
    if (!['counter', 'delivery'].includes(normalizedDeliveryType)) {
      throw AppError.badRequest(
        'delivery_type must be counter or delivery',
        'PHARMACY_ORDER_DELIVERY_TYPE_INVALID',
      );
    }
    if (normalizedDeliveryType === 'counter' && [
      delivery_address, delivery_landmark, delivery_lat, delivery_lng, delivery_phone,
    ].some((value) => value != null && String(value).trim() !== '')) {
      throw AppError.badRequest(
        'Counter pickup orders cannot include delivery-only fields',
        'PHARMACY_ORDER_COUNTER_DELIVERY_FIELDS_INVALID',
      );
    }

    let prescriptionPhotoKey = null;
    if (req.file) {
      // Screen BEFORE anything is stored (FILE_SCAN_POLICY, shared with every
      // ingest path). Refusals throw 422/503 AppErrors and nothing is written.
      await screenUploadBuffer(req.file.buffer, {
        subject: 'Prescription photo',
        context: { patientId, route: 'pharmacy-order-prescription-photo' },
      });
      const timestamp = Date.now();
      const ext = req.file.originalname?.split('.').pop() || 'jpg';
      prescriptionPhotoKey = `pharmacy/prescriptions/${patientId}/${timestamp}.${ext}`;
      await uploadFileToR2(req.file.buffer, prescriptionPhotoKey, req.file.mimetype);
    }

    const order = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, patientId });
      const patients = await tx.$queryRawUnsafe(
        `SELECT id, uid, name, phone
           FROM users
          WHERE id=$1::int AND tenant_id=$2::uuid
            AND uid=$3::uuid AND role='PATIENT'
            AND is_active=TRUE AND status='active'
            AND is_deleted=FALSE AND merged_into_uid IS NULL
          FOR KEY SHARE`,
        patientId,
        req.tenantId,
        req.user?.uid || null,
      );
      if (!patients[0]) {
        throw AppError.forbidden(
          'Patient identity is not active for this tenant',
          'PHARMACY_ORDER_PATIENT_AUTHORITY_INVALID',
        );
      }
      const patientName = patients[0].name;
      const patientPhone = patients[0].phone || '';
      if (normalizedDeliveryType === 'delivery'
        && (!String(delivery_address || '').trim()
          || !String(delivery_phone || patientPhone).trim())) {
        throw AppError.badRequest(
          'Delivery orders require an address and delivery phone',
          'PHARMACY_ORDER_DELIVERY_CONTACT_REQUIRED',
        );
      }
      const facility = await resolvePharmacyFacility(tx, {
        tenantId: req.tenantId,
        requestedFacilityId: requestedPharmacyFacilityId(req),
        forUpdate: true,
        requireActorGrant: false,
      });
      const result = await tx.$queryRawUnsafe(`
        INSERT INTO pharmacy_orders (
          patient_id, phone, patient_name, patient_phone, order_note,
          prescription_photo_key, delivery_type,
          delivery_address, delivery_landmark, delivery_lat, delivery_lng,
          delivery_phone, status, prescribed_by, tenant_id, facility_id, ordered_at, updated_at
          , authority_origin
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13::uuid,$14::uuid,$15::int, NOW(), NOW(), 'patient_manual')
        RETURNING id, uid, tenant_id, patient_id, patient_name, patient_phone, phone, status,
          order_note, total_amount, created_at, updated_at, order_number, delivery_type
      `,
        patientId, patientPhone, patientName, patientPhone,
        String(order_note || '').trim() || 'Prescription photo uploaded', prescriptionPhotoKey,
        normalizedDeliveryType,
        delivery_address || null, delivery_landmark || null,
        delivery_lat || null, delivery_lng || null,
        delivery_phone || patientPhone,
        req.user?.uid || null,
        req.tenantId,
        facility.id,
      );
      const created = result[0];

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2, 'PENDING', $3, 'patient', 'Order placed')`,
        req.tenantId, created.id, patientId
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_created', {
        ...created,
        patient_uid: req.user?.uid || null,
      }, {
        to_status: 'PENDING',
        delivery_type: created.delivery_type || delivery_type || null,
      });
      return created;
    });

    setImmediate(() => {
      // Trace only — no pharmacist alert is dispatched here. (The vestigial
      // `import('smsService.js')` this block used to perform sent nothing and
      // implied one; removed with audit 2026-08-09 finding F7.)
      try {
        // Don't log raw patient name (PHI). Identify by order + patient id.
        logger.info(`Pharmacy order ${order.order_number} placed by patient ${patientId}`);
      } catch (e) {
        // A throw here would be an unhandled exception on the event loop.
        logger.warn('Pharmacy order placement trace failed:', e.message);
      }
    });

    success(res, order, `Order placed. ${order.order_number}`);
  } catch (err) {
    logger.error('Place pharmacy order error:', err);
    // Screening refusals (422/503) are deliberate caller-facing answers.
    if (err?.statusCode) return relayAppError(res, err, 'Failed to place order', { safe: true });
    error(res, 'Failed to place order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getMyOrders = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const patientId = req.user?.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // Surface `items_list` (the dispensed medication schedule —
    // name/dose/route/frequency/duration/instructions per line item).
    // Without it the patient sees only "DISPENSED" + an order note and
    // cannot safely administer multi-medication regimens at home (e.g.
    // post-cataract eye drops: Moxifloxacin QID, Prednisolone QID taper,
    // Nepafenac BD). Finding
    // 2026-05-10-surgical-day-care-patient-pharmacy-order-omits-eye-drop-schedule.
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, prescription_url, prescription_photo_key,
        status, order_note, delivery_type, delivery_address, delivery_landmark,
        total_amount, payment_status, assigned_pharmacist, token_number,
        items_list,
        created_at, updated_at, dispatched_at, delivered_at
       FROM pharmacy_orders WHERE patient_id=$1 AND tenant_id=$2::uuid
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      patientId, tenantId, limit, offset);

    const orders = await Promise.all(result.map(attachSignedUrl));
    success(res, orders, 'My orders', HTTP_STATUS.OK, { limit, offset });
  } catch (err) {
    logger.error('Get my pharmacy orders error:', err);
    error(res, 'Failed to fetch orders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PHARMACIST / STAFF ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

function lineIdentityRecoveryProjection(order) {
  if (Number(order?.linked_prescription_count) !== 1) {
    return {
      line_identity_recovery_required: false,
      line_identity_recovery_suggestions: [],
      line_identity_recovery_source_lines: [],
    };
  }
  const medications = Array.isArray(order.prescription_medications)
    ? order.prescription_medications
    : [];
  const storedLines = Array.isArray(order.items_list) ? order.items_list : [];
  const sourceLines = storedLines.length
    ? storedLines
    : medications.map((medication, index) => ({
      order_line_index: index,
      catalog_id: Number(medication?.catalog_id) || null,
      name: medication?.name || medication?.medication_name || medication?.generic_name || null,
      quantity: Number(medication?.quantity ?? medication?.qty) || null,
      recovery_source: 'linked_prescription',
    }));
  const suggestions = sourceLines.map((line, index) => {
    const candidates = new Set([
      Number(line?.catalog_id),
      Number(line?.original_catalog_id),
      ...((Array.isArray(line?.substitution_history) ? line.substitution_history : [])
        .flatMap((entry) => [
          Number(entry?.original_catalog_id),
          Number(entry?.final_catalog_id),
        ])),
    ].filter((catalogId) => Number.isSafeInteger(catalogId) && catalogId > 0));
    const candidatePrescriptionLineIndexes = medications
      .map((medication, prescriptionLineIndex) => (
        candidates.has(Number(medication?.catalog_id)) ? prescriptionLineIndex : null
      ))
      .filter((prescriptionLineIndex) => prescriptionLineIndex != null);
    const storedPrescriptionLineIndex = Number(line?.prescription_line_index);
    const storedIdentityValid = Number(line?.order_line_index) === index
      && Number.isSafeInteger(storedPrescriptionLineIndex)
      && storedPrescriptionLineIndex >= 0
      && candidatePrescriptionLineIndexes.includes(storedPrescriptionLineIndex);
    return {
      order_line_index: index,
      current_prescription_line_index: storedIdentityValid ? storedPrescriptionLineIndex : null,
      suggested_prescription_line_index: candidatePrescriptionLineIndexes.length === 1
        ? candidatePrescriptionLineIndexes[0]
        : null,
      candidate_prescription_line_indexes: candidatePrescriptionLineIndexes,
      suggestion_basis: 'catalog_identity',
      resolved: storedIdentityValid,
    };
  });
  return {
    line_identity_recovery_required: storedLines.length === 0
      || suggestions.some((suggestion) => !suggestion.resolved),
    line_identity_recovery_suggestions: suggestions,
    line_identity_recovery_source_lines: sourceLines,
  };
}

export const getOrderQueue = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const facility = await resolvePharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const { status, from_date, to_date } = req.query;
    const mayRecoverFacility = PHARMACY_FACILITY_ASSIGNMENT_ROLES.has(req.user?.role);
    let where = `WHERE po.tenant_id=$1::uuid
      AND (po.facility_id=$2::int${mayRecoverFacility ? ' OR po.facility_id IS NULL' : ''})`;
    const params = [tenantId, facility.id];

    if (status) {
      params.push(status);
      where += ` AND po.status=$${params.length}`;
    }
    if (from_date) {
      params.push(from_date);
      where += ` AND DATE(po.created_at)>=$${params.length}`;
    }
    if (to_date) {
      params.push(to_date);
      where += ` AND DATE(po.created_at)<=$${params.length}`;
    }

    const result = await prisma.$queryRawUnsafe(`
      SELECT po.id, po.uid, po.patient_id, po.patient_name, po.patient_phone, po.prescription_url,
        po.prescription_photo_key, po.status, po.order_note, po.delivery_type, po.delivery_address,
        po.total_amount, po.payment_status, po.payment_mode, po.amount_collected,
        po.payment_metadata, po.assigned_pharmacist, po.token_number,
        po.items_list, po.facility_id, po.order_number, po.inventory_authority_version,
        po.delivery_assignee_uid, po.delivery_handoff_generation,
        po.delivery_custody_status, po.delivery_tracking_active,
        po.clinical_verification_status, po.clinically_verified_order_version,
        rx_link.prescription_id, rx_link.linked_prescription_count,
        rx_link.prescription_medications,
        CASE WHEN rx_link.linked_prescription_count=1 THEN (
          jsonb_array_length(COALESCE(po.items_list, '[]'::jsonb))=0
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(po.items_list, '[]'::jsonb))
                   WITH ORDINALITY AS order_line(value, ordinality)
             WHERE NOT (
               (order_line.value->>'order_line_index') ~ '^[0-9]+$'
               AND (order_line.value->>'order_line_index')::int = order_line.ordinality::int - 1
               AND (order_line.value->>'prescription_line_index') ~ '^[0-9]+$'
             )
          )
        ) ELSE FALSE END AS line_identity_recovery_required,
        (po.facility_id IS NULL) AS facility_recovery_required,
        CASE WHEN po.facility_id IS NULL THEN $2::int ELSE NULL END AS facility_recovery_target_id,
        po.created_at, po.updated_at, po.dispatched_at, po.delivered_at,
        EXTRACT(EPOCH FROM (NOW()-po.created_at))/60 as mins_since_placed,
        CASE WHEN po.status='PENDING' AND po.sla_confirm_target IS NOT NULL AND NOW()>po.sla_confirm_target THEN TRUE ELSE FALSE END as sla_breached
      FROM pharmacy_orders po
      LEFT JOIN LATERAL (
        SELECT MIN(ep.id)::int AS prescription_id,
               COUNT(*)::int AS linked_prescription_count,
               (ARRAY_AGG(ep.medications ORDER BY ep.id))[1] AS prescription_medications
          FROM e_prescriptions ep
          JOIN users patient
            ON patient.tenant_id=ep.tenant_id
           AND patient.id=ep.patient_id
           AND patient.uid=ep.patient_uid
           AND patient.role='PATIENT'
           AND patient.is_active=TRUE
           AND patient.status='active'
           AND patient.is_deleted=FALSE
           AND patient.merged_into_uid IS NULL
         WHERE ep.tenant_id=po.tenant_id
           AND ep.pharmacy_order_id=po.id
           AND ep.patient_id=po.patient_id
      ) rx_link ON TRUE
      ${where}
      ORDER BY
        CASE po.status
          WHEN 'PENDING' THEN 1
          WHEN 'CONFIRMED' THEN 2
          WHEN 'PREPARING' THEN 3
          WHEN 'DISPATCHED' THEN 4
          ELSE 5
        END,
        po.created_at ASC
    `, ...params);

    const orders = await Promise.all(result.map(async (order) => ({
      ...await attachSignedUrl(order),
      ...lineIdentityRecoveryProjection(order),
    })));
    success(res, orders, 'Order queue');
  } catch (err) {
    logger.error('Get pharmacy order queue error:', err);
    return relayAppError(res, err, 'Failed to fetch order queue');
  }
};

export const assignOrderFacility = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    if (!PHARMACY_FACILITY_ASSIGNMENT_ROLES.has(req.user?.role)) {
      throw AppError.forbidden(
        'Only pharmacy in-charge or tenant administration may assign legacy order custody',
        'PHARMACY_FACILITY_ASSIGNMENT_FORBIDDEN',
      );
    }
    const orderId = pharmacyOrderIdOrNull(req.params.id);
    if (!orderId) {
      throw AppError.badRequest('Valid order id is required', 'PHARMACY_ORDER_ID_INVALID');
    }
    const requestedFacilityId = Number(req.body?.facility_id);
    if (!Number.isSafeInteger(requestedFacilityId) || requestedFacilityId <= 0
      || requestedFacilityId > PG_INT4_MAX) {
      throw AppError.badRequest('facility_id is required', 'PHARMACY_FACILITY_INVALID');
    }
    const result = await setTenantTx(tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId, orderId });
      const facility = await resolvePharmacyFacility(tx, {
        tenantId,
        ...pharmacyFacilityActorFromRequest(req),
        requestedFacilityId,
        forUpdate: true,
      });
      const orders = await tx.$queryRawUnsafe(
        `SELECT id, uid, status, facility_id, items_list, inventory_authority_version,
                clinical_verification_status, order_number, patient_id, patient_name
           FROM pharmacy_orders
          WHERE tenant_id=$1::uuid AND id=$2::int
          FOR UPDATE`,
        tenantId,
        orderId,
      );
      if (!orders.length) throw AppError.notFound('Pharmacy order not found');
      const hasIssueEvidence = (Array.isArray(orders[0].items_list)
        ? orders[0].items_list
        : []).some((line) => (
        Number(line?.inventory_dispensed_quantity || 0) > 0
        || Number(line?.inventory_billable_total || 0) > 0
        || (Array.isArray(line?.inventory_allocation_evidence)
          && line.inventory_allocation_evidence.length > 0)
        || (Array.isArray(line?.substitution_history)
          && line.substitution_history.some((entry) => entry?.movement_id != null))
      ));
      if (!['PENDING', 'CONFIRMED', 'PREPARING', 'ON_HOLD'].includes(orders[0].status)
        || hasIssueEvidence) {
        throw AppError.conflict(
          'Legacy facility assignment is allowed only before inventory issue or dispatch',
          'PHARMACY_ORDER_FACILITY_ASSIGNMENT_AFTER_ISSUE',
          { recovery_action: 'reconcile_historical_custody_from_inventory_movements' },
        );
      }
      if (orders[0].facility_id != null) {
        if (Number(orders[0].facility_id) === facility.id) return { order: orders[0], changed: false };
        throw AppError.conflict(
          'The pharmacy order already has a different facility authority',
          'PHARMACY_ORDER_FACILITY_ALREADY_ASSIGNED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET facility_id=$3::int,
                inventory_authority_version=inventory_authority_version+1,
                clinical_verification_status='pending',
                clinically_verified_by=NULL,
                clinically_verified_at=NULL,
                clinically_verified_order_version=NULL,
                clinical_verification_items_sha256=NULL,
                clinical_verification_catalog_sha256=NULL,
                clinical_verification_safety_version=NULL,
                clinical_verification_kb_version=NULL,
                clinical_verification_ruleset_version=NULL,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id IS NULL
          RETURNING id, uid, status, facility_id, inventory_authority_version,
                    clinical_verification_status, order_number, patient_id, patient_name`,
        tenantId,
        orderId,
        facility.id,
      );
      if (!updated.length) {
        throw AppError.conflict(
          'The order facility authority changed before assignment',
          'PHARMACY_ORDER_FACILITY_STATE_CHANGED',
        );
      }
      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, $3, $3, $4, $5, $6)`,
        tenantId,
        orderId,
        updated[0].status,
        req.user?.id || null,
        req.user?.role || null,
        `Facility custody assigned to ${facility.display_name || facility.facility_code || facility.id}`,
      );
      return { order: updated[0], changed: true };
    });
    if (result.changed) auditPharmacyOrder(req, 'PHARMACY_ORDER_FACILITY_ASSIGNED', result.order, {
      facility_id: Number(result.order.facility_id),
    });
    return success(res, result.order, 'Order facility assigned');
  } catch (err) {
    return relayAppError(res, err, 'Failed to assign order facility');
  }
};

export const resolveOrderLineIdentities = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    if (!PHARMACY_FACILITY_ASSIGNMENT_ROLES.has(req.user?.role)) {
      throw AppError.forbidden(
        'Only pharmacy in-charge or tenant administration may repair prescription line identities',
        'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_FORBIDDEN',
      );
    }
    const orderId = pharmacyOrderIdOrNull(req.params.id);
    const requestedMappings = req.body?.line_mappings;
    if (!orderId || !Array.isArray(requestedMappings)) {
      throw AppError.badRequest(
        'Valid order id and line_mappings are required',
        'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INVALID',
      );
    }
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const result = await setTenantTx(tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId, orderId });
      await resolveOrderPharmacyFacility(tx, {
        tenantId,
        ...pharmacyFacilityActorFromRequest(req),
        orderId,
        requestedFacilityId: facility.id,
        forUpdate: true,
      });
      const orders = await tx.$queryRawUnsafe(
        `SELECT id, status, items_list, facility_id, inventory_authority_version,
                clinical_verification_status, order_number, patient_id, patient_name
           FROM pharmacy_orders
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
          FOR UPDATE`,
        tenantId,
        orderId,
        facility.id,
      );
      if (!orders.length) throw AppError.notFound('Pharmacy order not found');
      if (!['PENDING', 'CONFIRMED', 'PREPARING'].includes(orders[0].status)) {
        throw AppError.conflict(
          'Prescription line identity can be repaired only before medication issue',
          'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_WRONG_STATUS',
          { status: orders[0].status },
        );
      }
      const prescriptions = await assertLinkedPrescriptionPatientAuthorityTx(
        tx,
        tenantId,
        orderId,
      );
      if (prescriptions.length !== 1) {
        throw AppError.conflict(
          'Prescription line identity repair requires exactly one linked prescription',
          'PHARMACY_ORDER_PRESCRIPTION_LINK_AMBIGUOUS',
        );
      }
      const lines = Array.isArray(orders[0].items_list)
        ? orders[0].items_list.map((line) => ({ ...line }))
        : [];
      if (lines.some((line) => (
        Number(line?.inventory_dispensed_quantity || 0) > 0
        || Number(line?.inventory_billable_total || 0) > 0
        || (Array.isArray(line?.inventory_allocation_evidence)
          && line.inventory_allocation_evidence.length > 0)
        || (Array.isArray(line?.substitution_history)
          && line.substitution_history.some((entry) => entry?.movement_id != null))
      ))) {
        throw AppError.conflict(
          'Prescription line identity cannot be repaired after inventory issue evidence exists',
          'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_AFTER_ISSUE',
          { recovery_action: 'reconcile_or_return_issued_inventory_before_line_repair' },
        );
      }
      const medications = Array.isArray(prescriptions[0].medications)
        ? prescriptions[0].medications
        : [];
      const expectedLineCount = medications.length;
      if (!expectedLineCount || requestedMappings.length !== expectedLineCount) {
        throw AppError.unprocessable(
          'line_mappings must provide one exact mapping for every recoverable order line',
          'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INCOMPLETE',
          { expected_line_count: expectedLineCount },
        );
      }
      const mappingByOrderLine = new Map();
      const mappedPrescriptionLines = new Set();
      for (const mapping of requestedMappings) {
        const orderLineIndex = Number(mapping?.order_line_index);
        const prescriptionLineIndex = Number(mapping?.prescription_line_index);
        if (!Number.isSafeInteger(orderLineIndex) || orderLineIndex < 0
          || !Number.isSafeInteger(prescriptionLineIndex) || prescriptionLineIndex < 0
          || mappingByOrderLine.has(orderLineIndex)
          || mappedPrescriptionLines.has(prescriptionLineIndex)) {
          throw AppError.unprocessable(
            'Every line mapping requires unique non-negative order and prescription indexes',
            'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INVALID',
          );
        }
        mappingByOrderLine.set(orderLineIndex, prescriptionLineIndex);
        mappedPrescriptionLines.add(prescriptionLineIndex);
      }
      if ([...mappedPrescriptionLines].sort((left, right) => left - right)
        .some((lineIndex, expectedIndex) => lineIndex !== expectedIndex)) {
        throw AppError.unprocessable(
          'Line identity recovery must map every linked prescription line exactly once',
          'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INCOMPLETE',
          { expected_prescription_line_indexes: medications.map((_, index) => index) },
        );
      }
      const recoveryIdentityLines = [...mappingByOrderLine.entries()]
        .sort(([left], [right]) => left - right)
        .map(([orderLineIndex, prescriptionLineIndex], expectedIndex) => {
          if (orderLineIndex !== expectedIndex) {
            throw AppError.unprocessable(
              'Recovered order line indexes must be contiguous from zero',
              'PHARMACY_ORDER_LINE_IDENTITY_REPAIR_INVALID',
            );
          }
          return { order_line_index: orderLineIndex, prescription_line_index: prescriptionLineIndex };
        });
      const confirmation = await resolvePrescriptionConfirmationLinesTx(tx, {
        tenantId,
        facilityId: orders[0].facility_id,
        storedItems: recoveryIdentityLines,
        requestedItems: undefined,
        prescriptionMedications: medications,
        requestedTotal: null,
      });
      const mappedLines = confirmation.lines;
      const alreadyMapped = JSON.stringify(mappedLines) === JSON.stringify(lines);
      if (alreadyMapped) return { order: orders[0], changed: false };
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET items_list=$3::jsonb,
                inventory_authority_version=inventory_authority_version+1,
                clinical_verification_status='pending',
                clinically_verified_by=NULL,
                clinically_verified_at=NULL,
                clinically_verified_order_version=NULL,
                clinical_verification_items_sha256=NULL,
                clinical_verification_catalog_sha256=NULL,
                clinical_verification_safety_version=NULL,
                clinical_verification_kb_version=NULL,
                clinical_verification_ruleset_version=NULL,
                total_amount=$5::numeric,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$4::int
          RETURNING id, status, items_list, facility_id, inventory_authority_version,
                    clinical_verification_status, order_number, patient_id, patient_name`,
        tenantId,
        orderId,
        JSON.stringify(mappedLines),
        facility.id,
        confirmation.total,
      );
      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, $3, $3, $4, $5, $6)`,
        tenantId,
        orderId,
        orders[0].status,
        req.user?.id || null,
        req.user?.role || null,
        'Legacy prescription line identities repaired by explicit operator mapping',
      );
      return { order: updated[0], changed: true };
    });
    if (result.changed) auditPharmacyOrder(req, 'PHARMACY_ORDER_LINE_IDENTITIES_REPAIRED', result.order);
    return success(res, result.order, 'Prescription line identities resolved');
  } catch (err) {
    return relayAppError(res, err, 'Failed to resolve prescription line identities');
  }
};

export function preserveBoundOrderLineIdentity(existingItems, requestedItems) {
  const authoritative = Array.isArray(existingItems) ? existingItems : [];
  const hasPrescriptionLineAuthority = authoritative.length > 0
    && authoritative.every((line, index) => (
      line
      && typeof line === 'object'
      && !Array.isArray(line)
      && Number(line.order_line_index) === index
      && Number.isSafeInteger(Number(line.prescription_line_index))
      && Number(line.prescription_line_index) >= 0
    ));
  if (hasPrescriptionLineAuthority) {
    if (requestedItems !== undefined
      && JSON.stringify(requestedItems) !== JSON.stringify(authoritative)) {
      throw AppError.conflict(
        'Prescription-bound order lines are immutable; update the prescription instead',
        'PHARMACY_ORDER_ITEMS_IMMUTABLE',
        { recovery_action: 'refresh_order' },
      );
    }
    return authoritative.map((line) => ({ ...line }));
  }
  throw AppError.conflict(
    'Prescription-bound order lines require governed identity recovery before confirmation',
    'PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED',
    { recovery_action: 'resolve_line_identities' },
  );
}

async function resolvePrescriptionConfirmationLinesTx(tx, {
  tenantId,
  facilityId,
  storedItems,
  requestedItems,
  prescriptionMedications,
  requestedTotal,
}) {
  const bound = preserveBoundOrderLineIdentity(storedItems, requestedItems);
  resolvePrescriptionLineIndexes(bound, prescriptionMedications);
  const catalogIds = [...new Set(bound.map((line) => {
    const medication = prescriptionMedications[Number(line.prescription_line_index)];
    return Number(medication?.catalog_id);
  }))].sort((left, right) => left - right);
  if (catalogIds.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > PG_INT4_MAX)) {
    throw AppError.conflict(
      'A linked prescription line has no authoritative catalog identity',
      'PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED',
      { recovery_action: 'amend_prescription' },
    );
  }
  const catalogs = await tx.$queryRawUnsafe(
    `SELECT id, name, generic_name, unit_price
       FROM pharmacy_catalog
      WHERE tenant_id=$1::uuid AND id=ANY($2::int[]) AND is_active=TRUE
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    catalogIds,
  );
  const items = await tx.$queryRawUnsafe(
    `SELECT id, catalog_id
       FROM pharmacy_inventory_items
      WHERE tenant_id=$1::uuid AND facility_id=$2::int
        AND catalog_id=ANY($3::int[]) AND status='active'
      ORDER BY catalog_id, id
      FOR UPDATE`,
    tenantId,
    Number(facilityId),
    catalogIds,
  );
  const catalogById = new Map(catalogs.map((row) => [Number(row.id), row]));
  const resolved = bound.map((line, orderLineIndex) => {
    const prescriptionLineIndex = Number(line.prescription_line_index);
    const medication = prescriptionMedications[prescriptionLineIndex];
    const catalogId = Number(medication.catalog_id);
    const catalog = catalogById.get(catalogId);
    const candidates = items.filter((item) => Number(item.catalog_id) === catalogId);
    const quantity = Number(
      medication.ordered_quantity ?? medication.quantity ?? medication.qty,
    );
    const unitPrice = Number(catalog?.unit_price);
    if (!catalog || candidates.length !== 1
      || !Number.isFinite(quantity) || quantity <= 0
      || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw AppError.conflict(
        'The linked prescription cannot be projected to one active priced facility item',
        'PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED',
        {
          order_line_index: orderLineIndex,
          prescription_line_index: prescriptionLineIndex,
          catalog_id: catalogId,
          facility_id: Number(facilityId),
          inventory_item_candidates: candidates.map((item) => Number(item.id)),
        },
      );
    }
    return {
      order_line_index: orderLineIndex,
      prescription_line_index: prescriptionLineIndex,
      catalog_id: catalogId,
      inventory_item_id: Number(candidates[0].id),
      name: catalog.name,
      generic_name: catalog.generic_name || medication.generic_name || null,
      quantity,
      qty: quantity,
      ordered_qty: quantity,
      dose: medication.dose ?? medication.dosage ?? medication.strength ?? null,
      strength: medication.strength ?? null,
      form: medication.form ?? null,
      frequency: medication.frequency ?? medication.freq ?? null,
      route: medication.route ?? null,
      days: medication.days ?? medication.duration_days ?? medication.duration ?? null,
      instructions: medication.instructions ?? medication.label_instruction ?? null,
      price: unitPrice,
      line_total: Number((unitPrice * quantity).toFixed(2)),
    };
  });
  const total = Number(resolved.reduce((sum, line) => sum + line.line_total, 0).toFixed(2));
  if (requestedTotal != null && Math.abs(Number(requestedTotal) - total) > 0.001) {
    throw AppError.conflict(
      'total_amount does not match authoritative prescription catalog pricing',
      'PHARMACY_ORDER_TOTAL_MISMATCH',
      { submitted_total_amount: Number(requestedTotal), authoritative_total_amount: total },
    );
  }
  return { lines: resolved, total };
}

async function resolveManualConfirmationLinesTx(tx, {
  tenantId,
  facilityId,
  requestedItems,
  requestedTotal,
}) {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    throw AppError.unprocessable(
      'Manual/photo orders require at least one authoritative catalog line',
      'PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED',
      { recovery_action: 'select_catalog_items' },
    );
  }
  const parsed = requestedItems.map((line, index) => {
    const catalogId = Number(line?.catalog_id);
    const inventoryItemId = line?.inventory_item_id == null
      ? null
      : Number(line.inventory_item_id);
    const quantity = canonicalManualConfirmationQuantity(
      line?.quantity ?? line?.qty,
      index,
    );
    if (Number(line?.order_line_index) !== index
      || !Number.isSafeInteger(catalogId) || catalogId <= 0
      || catalogId > PG_INT4_MAX
      || (inventoryItemId != null
        && (!Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0
          || inventoryItemId > PG_INT4_MAX))) {
      throw manualConfirmationLineError(index);
    }
    return {
      index,
      catalogId,
      inventoryItemId,
      quantity,
      dose: line?.dose ?? line?.dosage ?? line?.strength ?? null,
      frequency: line?.frequency ?? line?.freq ?? null,
      route: line?.route ?? null,
      days: line?.days ?? line?.duration_days ?? line?.duration ?? null,
      instructions: line?.instructions ?? line?.label_instruction ?? null,
    };
  });
  const catalogIds = [...new Set(parsed.map((line) => line.catalogId))].sort((a, b) => a - b);
  const catalogs = await tx.$queryRawUnsafe(
    `SELECT id, name, generic_name, unit_price
       FROM pharmacy_catalog
      WHERE tenant_id=$1::uuid AND id=ANY($2::int[]) AND is_active=TRUE
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    catalogIds,
  );
  const inventory = await tx.$queryRawUnsafe(
    `SELECT id, catalog_id, display_name
       FROM pharmacy_inventory_items
      WHERE tenant_id=$1::uuid AND facility_id=$2::int
        AND catalog_id=ANY($3::int[]) AND status='active'
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    Number(facilityId),
    catalogIds,
  );
  const catalogById = new Map(catalogs.map((row) => [Number(row.id), row]));
  const lines = parsed.map(({
    index,
    catalogId,
    inventoryItemId,
    quantity,
    dose,
    frequency,
    route,
    days,
    instructions,
  }) => {
    const catalog = catalogById.get(catalogId);
    const candidates = inventory.filter((row) => Number(row.catalog_id) === catalogId
      && (inventoryItemId == null || Number(row.id) === inventoryItemId));
    if (!catalog || candidates.length !== 1) {
      throw AppError.conflict(
        candidates.length > 1
          ? `Catalog line ${catalogId} maps to multiple facility inventory items`
          : `Catalog line ${catalogId} has no active facility inventory item`,
        'PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED',
        {
          order_line_index: index,
          catalog_id: catalogId,
          facility_id: Number(facilityId),
          inventory_item_candidates: candidates.map((row) => ({
            inventory_item_id: Number(row.id),
            display_name: row.display_name || null,
          })),
          recovery_action: candidates.length > 1
            ? 'select_inventory_item'
            : 'configure_catalog_inventory_link',
        },
      );
    }
    const unitPrice = Number(catalog.unit_price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw AppError.conflict(
        `Catalog line ${catalogId} has no positive authoritative price`,
        'PHARMACY_ORDER_CATALOG_PRICE_REQUIRED',
      );
    }
    return {
      order_line_index: index,
      catalog_id: catalogId,
      inventory_item_id: Number(candidates[0].id),
      name: catalog.name,
      generic_name: catalog.generic_name || null,
      quantity,
      qty: quantity,
      ordered_qty: quantity,
      dose,
      frequency,
      route,
      days,
      instructions,
      price: unitPrice,
      line_total: Number((unitPrice * quantity).toFixed(2)),
    };
  });
  const total = Number(lines.reduce((sum, line) => sum + line.line_total, 0).toFixed(2));
  if (requestedTotal != null && Math.abs(Number(requestedTotal) - total) > 0.001) {
    throw AppError.conflict(
      'total_amount does not match authoritative catalog pricing',
      'PHARMACY_ORDER_TOTAL_MISMATCH',
      { submitted_total_amount: Number(requestedTotal), authoritative_total_amount: total },
    );
  }
  return { lines, total };
}

export const confirmOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const orderId = requirePharmacyOrderId(id);
    const command = pharmacyOrderCommand(req, orderId, 'confirm');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Order confirmed',
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const staffId = req.user?.id;
    const { confirmation_notes, items_list, total_amount } = req.body;

    if (items_list !== undefined) {
      if (!Array.isArray(items_list)) return error(res, 'items_list must be an array', HTTP_STATUS.BAD_REQUEST);
      if (items_list.length > 100) return error(res, 'items_list exceeds maximum of 100 items', HTTP_STATUS.BAD_REQUEST);
      for (const item of items_list) {
        if (typeof item !== 'object' || item === null) return error(res, 'Each item must be an object', HTTP_STATUS.BAD_REQUEST);
      }
    }

    const order = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, phone, prescription_url, status,
        order_note, delivery_type, delivery_address, total_amount, payment_status, assigned_pharmacist,
        token_number, order_number, delivery_phone, items_list, created_at, updated_at,
        dispatched_at, delivered_at
       FROM pharmacy_orders WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int`,
      parseInt(id), req.tenantId, facility.id);
    if (!order.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      await resolveOrderPharmacyFacility(tx, {
        tenantId: req.tenantId,
        ...pharmacyFacilityActorFromRequest(req),
        orderId,
        requestedFacilityId: facility.id,
        forUpdate: true,
      });
      const locked = await tx.$queryRawUnsafe(
        `SELECT id, status, items_list, total_amount, facility_id, patient_id
           FROM pharmacy_orders
          WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int
          FOR UPDATE`,
        parseInt(id), req.tenantId, facility.id,
      );
      if (!locked.length || locked[0].status !== 'PENDING') return null;
      const linkedPrescriptions = await assertLinkedPrescriptionPatientAuthorityTx(
        tx,
        req.tenantId,
        orderId,
      );
      if (linkedPrescriptions.length > 1) {
        throw AppError.conflict(
          'Pharmacy order is linked to more than one prescription',
          'PHARMACY_ORDER_PRESCRIPTION_LINK_AMBIGUOUS',
        );
      }
      const hasPrescriptionAuthority = linkedPrescriptions.length === 1;
      const confirmedItems = Array.isArray(items_list)
        ? items_list.map((line) => ({ ...line }))
        : [];
      const confirmation = hasPrescriptionAuthority
        ? await resolvePrescriptionConfirmationLinesTx(tx, {
          tenantId: req.tenantId,
          facilityId: locked[0].facility_id,
          storedItems: locked[0].items_list,
          requestedItems: items_list,
          prescriptionMedications: Array.isArray(linkedPrescriptions[0].medications)
            ? linkedPrescriptions[0].medications
            : [],
          requestedTotal: total_amount,
        })
        : await resolveManualConfirmationLinesTx(tx, {
          tenantId: req.tenantId,
          facilityId: locked[0].facility_id,
          requestedItems: confirmedItems,
          requestedTotal: total_amount,
        });
      const updated = await tx.$queryRawUnsafe(`
        UPDATE pharmacy_orders SET
          status='CONFIRMED', confirmed_by=$1, confirmed_at=NOW(),
          confirmation_notes=$2, items_list=$3::jsonb, total_amount=$4,
          inventory_authority_version=inventory_authority_version+1,
          clinical_verification_status='pending',
          clinically_verified_order_version=NULL,
          clinical_verification_items_sha256=NULL,
          clinical_verification_catalog_sha256=NULL,
          clinical_verification_safety_version=NULL,
          clinical_verification_kb_version=NULL,
          clinical_verification_ruleset_version=NULL,
          sla_dispatch_target=NOW()+INTERVAL '30 minutes', updated_at=NOW()
        WHERE id=$5 AND tenant_id=$6::uuid AND facility_id=$7::int AND status='PENDING'
        RETURNING id, uid, tenant_id, patient_id, patient_name, status, order_note, total_amount,
          confirmation_notes, items_list, created_at, updated_at, order_number
      `,
        staffId, confirmation_notes || null,
        JSON.stringify(confirmation.lines),
        confirmation.total,
        parseInt(id),
        req.tenantId,
        facility.id,
      );
      if (!updated.length) return null;

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2, 'PENDING', 'CONFIRMED', $3, 'pharmacist', $4)`,
        req.tenantId, parseInt(id), staffId, confirmation_notes || null
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_confirmed', updated[0], {
        from_status: 'PENDING',
        to_status: 'CONFIRMED',
        item_count: confirmation.lines.length,
      });
      const payload = await storeOrderCommandReceiptTx(
        tx, req, orderId, command, updated[0], 'Order confirmed',
      );
      return { replay: false, payload };
    });

    if (!result) {
      throw AppError.conflict(
        'Can only confirm PENDING orders',
        'PHARMACY_ORDER_CONFIRM_WRONG_STATUS',
      );
    }

    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_CONFIRMED', { ...result.payload, order_number: order[0].order_number }, {
      from_status: 'PENDING',
      to_status: 'CONFIRMED',
    });
    if (!result.replay) setImmediate(async () => {
      try {
        const { queuePatientSms } = await import('../../utils/notifications/smsOutbox.js');
        const patientPhone = order[0].phone || order[0].delivery_phone;
        if (patientPhone) {
          await queuePatientSms({
            tenantId: result.payload?.tenant_id || req.tenantId,
            recipientId: order[0].patient_id,
            recipientPhone: patientPhone,
            title: 'Pharmacy order confirmed',
            body: `Dear ${order[0].patient_name || 'Patient'}, your pharmacy order ${order[0].order_number} is confirmed. Total: Rs.${result.payload?.total_amount ?? 'TBD'}. Cash on delivery.`,
            data: {
              type: 'pharmacy_order_confirmed',
              order_id: String(order[0].id),
              order_number: order[0].order_number || null,
            },
            sourceEventKey: `pharmacy-order-confirmed:${order[0].id}`,
            templateVersion: 'sms.pharmacy_order_confirmed.v1',
            context: 'pharmacy-order-confirmed',
          });
        }
      } catch (e) {
        logger.warn('Pharmacy confirm notification failed:', e.message);
      }
    });

    success(res, result.payload, 'Order confirmed');
  } catch (err) {
    // Stage-4-C — surface real cause. The previous catch-all "Failed to
    // confirm order" hid the actual DB / validation error so the
    // pharmacist couldn't tell whether the order was missing, already
    // confirmed, or hit a constraint. AppErrors keep their statusCode
    // + message; Postgres errors (FK violation 23503, unique 23505) map
    // to 400 with the constraint name so the operator at least knows
    // which input was wrong.
    // Finding: 2026-05-09-pediatric-opd-pharmacy-confirm-500
    if (err && typeof err.statusCode === 'number') {
      return relayAppError(res, err, 'Failed to confirm order');
    }
    if (err && typeof err.code === 'string' && err.code.startsWith('23')) {
      logger.error('Confirm pharmacy order DB constraint:', { code: err.code, detail: err.detail, constraint: err.constraint });
      return error(res, `Confirm rejected by database constraint ${err.constraint || err.code}`, HTTP_STATUS.BAD_REQUEST);
    }
    logger.error('Confirm pharmacy order error:', err);
    error(res, 'Failed to confirm order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const markPreparing = async (req, res) => {
  try {
    const { id } = req.params;
    const orderId = requirePharmacyOrderId(id);
    const command = pharmacyOrderCommand(req, orderId, 'preparing');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Preparing',
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      const verification = await assertVerificationClearedTx(tx, {
        orderId: parseInt(id, 10),
        tenantId: req.tenantId,
      });
      if (verification.delivery_type !== 'delivery') {
        throw AppError.conflict(
          'Counter orders cannot enter the delivery preparation workflow',
          'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders SET status='PREPARING', preparing_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int AND status='CONFIRMED'
         RETURNING id, uid, tenant_id, patient_id, patient_name, status, order_note,
           total_amount, created_at, updated_at, order_number`,
        parseInt(id), req.tenantId, facility.id
      );
      if (!updated.length) return null;

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role)
         VALUES ($1::uuid, $2, 'CONFIRMED', 'PREPARING', $3, 'pharmacist')`,
        req.tenantId, parseInt(id), req.user?.id
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_preparing', updated[0], {
        from_status: 'CONFIRMED',
        to_status: 'PREPARING',
      });
      const payload = await storeOrderCommandReceiptTx(
        tx, req, orderId, command, updated[0], 'Preparing',
      );
      return { replay: false, payload };
    });

    if (!result) {
      throw AppError.conflict(
        'Order must be CONFIRMED before preparation',
        'PHARMACY_ORDER_PREPARING_WRONG_STATUS',
      );
    }

    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_PREPARING', result.payload, {
      from_status: 'CONFIRMED',
      to_status: 'PREPARING',
    });
    success(res, result.payload, 'Preparing');
  } catch (err) {
    return relayAppError(res, err, 'Failed to update order');
  }
};

export const getDeliveryAssignees = async (req, res) => {
  try {
    const orderId = requirePharmacyOrderId(req.params.id);
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const assignees = await setTenantTx(req.tenantId, async (tx) => {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
      });
      return tx.$queryRawUnsafe(
        `SELECT courier.uid, COALESCE(NULLIF(BTRIM(staff.name), ''), courier.name) AS name,
                courier.phone, facility_grant.authority_version AS grant_version
           FROM users courier
           JOIN staff
             ON staff.tenant_id=courier.tenant_id AND staff.user_id=courier.uid
            AND staff.is_active=TRUE AND staff.archived=FALSE
           JOIN pharmacy_staff_facility_grants facility_grant
             ON facility_grant.tenant_id=courier.tenant_id
            AND facility_grant.staff_uid=courier.uid
            AND facility_grant.facility_id=$2::int
            AND facility_grant.status='active' AND facility_grant.revoked_at IS NULL
          WHERE courier.tenant_id=$1::uuid AND courier.role='DELIVERY_STAFF'
            AND courier.is_active=TRUE AND courier.status='active'
            AND courier.is_deleted=FALSE AND courier.merged_into_uid IS NULL
          ORDER BY COALESCE(NULLIF(BTRIM(staff.name), ''), courier.name), courier.uid`,
        req.tenantId,
        facility.id,
      );
    });
    return success(res, {
      facility_id: facility.id,
      delivery_assignees: assignees,
    }, 'Delivery assignees');
  } catch (err) {
    return relayAppError(res, err, 'Failed to load delivery assignees');
  }
};

export const getAssignedDeliveries = async (req, res) => {
  try {
    const actorUid = String(req.user?.uid || '').trim();
    const actorRole = String(req.user?.role || '').trim().toUpperCase();
    if (actorRole !== 'DELIVERY_STAFF' || !UUID_RE.test(actorUid)) {
      throw AppError.forbidden(
        'Assigned pharmacy deliveries require canonical delivery staff identity',
        'PHARMACY_DELIVERY_ASSIGNEE_FORBIDDEN',
      );
    }
    const deliveries = await setTenantTx(req.tenantId, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT pharmacy_order.id, pharmacy_order.order_number,
                pharmacy_order.patient_name, pharmacy_order.delivery_address,
                pharmacy_order.delivery_lat, pharmacy_order.delivery_lng,
                pharmacy_order.estimated_delivery_mins,
                pharmacy_order.delivery_distance_km,
                pharmacy_order.delivery_tracking_active,
                pharmacy_order.dispatched_at, pharmacy_order.facility_id,
                pharmacy_order.delivery_assignee_uid,
                pharmacy_order.delivery_handoff_generation,
                pharmacy_order.delivery_custody_status
           FROM pharmacy_orders pharmacy_order
           JOIN pharmacy_staff_facility_grants facility_grant
             ON facility_grant.tenant_id=pharmacy_order.tenant_id
            AND facility_grant.facility_id=pharmacy_order.facility_id
            AND facility_grant.staff_uid=$2::uuid
            AND facility_grant.status='active'
            AND facility_grant.revoked_at IS NULL
          WHERE pharmacy_order.tenant_id=$1::uuid
            AND pharmacy_order.delivery_assignee_uid=$2::uuid
            AND pharmacy_order.status='DISPATCHED'
            AND pharmacy_order.delivery_handoff_consumed_at IS NULL
            AND pharmacy_order.delivery_custody_status IN ('in_transit', 'return_pending')
          ORDER BY pharmacy_order.dispatched_at, pharmacy_order.id`,
        req.tenantId,
        actorUid,
      ));
    return success(res, { deliveries }, 'Assigned pharmacy deliveries');
  } catch (err) {
    return relayAppError(res, err, 'Failed to load assigned pharmacy deliveries');
  }
};

export const dispatchOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const orderId = requirePharmacyOrderId(id);
    const command = pharmacyOrderCommand(req, orderId, 'dispatch');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Order dispatched',
    );
    const staffId = req.user?.id;
    if (Object.hasOwn(req.body || {}, 'delivery_person')
      || Object.hasOwn(req.body || {}, 'delivery_person_phone')) {
      throw AppError.badRequest(
        'Delivery identity is resolved from delivery_assignee_uid',
        'PHARMACY_DELIVERY_CALLER_IDENTITY_FORBIDDEN',
      );
    }
    const deliveryAssigneeUid = String(req.body?.delivery_assignee_uid || '').trim();
    if (!UUID_RE.test(deliveryAssigneeUid)) {
      throw AppError.badRequest(
        'delivery_assignee_uid must identify the assigned courier',
        'PHARMACY_DELIVERY_ASSIGNEE_REQUIRED',
      );
    }
    const handoffToken = randomBytes(24).toString('base64url');
    const handoffTokenSha256 = deliveryHandoffSha256(req.tenantId, orderId, handoffToken);
    const dispatchCapOverride = pharmacyCapOverrideAuthority(
      req,
      req.body?.cap_override,
      req.body?.cap_override_reason,
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const validStatuses = ['CONFIRMED', 'PREPARING', 'READY'];
    const stagedOrder = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      await assertVerificationClearedTx(tx, { orderId, tenantId: req.tenantId });
      const rows = await tx.$queryRawUnsafe(
        `SELECT pharmacy_order.id, pharmacy_order.uid, pharmacy_order.patient_id,
                pharmacy_order.patient_name, patient.phone AS patient_phone,
                pharmacy_order.status, pharmacy_order.order_note,
                pharmacy_order.order_number, pharmacy_order.delivery_type,
                pharmacy_order.delivery_address, pharmacy_order.delivery_lat,
                pharmacy_order.delivery_lng, pharmacy_order.total_amount,
                pharmacy_order.items_list, pharmacy_order.payment_mode,
                pharmacy_order.payment_status, pharmacy_order.payment_metadata,
                pharmacy_order.inventory_authority_version, pharmacy_order.facility_id
           FROM pharmacy_orders pharmacy_order
           JOIN users patient
             ON patient.tenant_id=pharmacy_order.tenant_id
            AND patient.id=pharmacy_order.patient_id
            AND patient.role='PATIENT' AND patient.is_active=TRUE
            AND patient.status='active' AND patient.is_deleted=FALSE
            AND patient.merged_into_uid IS NULL
          WHERE pharmacy_order.id=$1::int AND pharmacy_order.tenant_id=$2::uuid
            AND pharmacy_order.facility_id=$3::int
          FOR UPDATE OF pharmacy_order, patient`,
        orderId,
        req.tenantId,
        facility.id,
      );
      if (!rows.length) throw AppError.notFound('Order not found');
      const locked = rows[0];
      const lockedStatus = String(locked.status || '').toUpperCase();
      if (!validStatuses.includes(lockedStatus)) {
        throw AppError.conflict(
          `Order cannot be staged for dispatch from status ${lockedStatus || 'unknown'}`,
          'PHARMACY_ORDER_DISPATCH_WRONG_STATUS',
          { current_status: lockedStatus || null, allowed_statuses: validStatuses },
        );
      }
      if (locked.delivery_type !== 'delivery') {
        throw AppError.conflict(
          'Counter orders cannot enter the delivery dispatch workflow',
          'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
        );
      }
      const requestedLines = applyAuthoritativeDeliveryAllocations(
        Array.isArray(locked.items_list) ? locked.items_list : [],
        Array.isArray(req.body?.dispensed_items) ? req.body.dispensed_items : [],
      );
      const authoritativeLines = await resolveCounterDispenseAuthorityTx(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        lines: requestedLines,
        completeRemainder: true,
      });
      const priorClinicalHash = clinicalOrderItemsSha256(locked.items_list);
      const stagedClinicalHash = clinicalOrderItemsSha256(authoritativeLines);
      if (priorClinicalHash !== stagedClinicalHash) {
        throw AppError.conflict(
          'Dispatch staging changed the clinically verified medication tuple',
          'PHARMACY_ORDER_DISPATCH_CLINICAL_AUTHORITY_CHANGED',
        );
      }
      const authoritativeTotal = Number(authoritativeLines
        .reduce((sum, line) => sum + Number(line.line_total || 0), 0)
        .toFixed(2));
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET items_list=$4::jsonb, total_amount=$5::numeric, updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
            AND status=$6
            AND inventory_authority_version=$7::int
          RETURNING id, uid, patient_id, patient_name, status, order_note,
                    order_number, delivery_type, delivery_address, delivery_lat,
                    delivery_lng, total_amount, items_list, payment_mode,
                    payment_status, payment_metadata, inventory_authority_version,
                    facility_id`,
        req.tenantId,
        orderId,
        facility.id,
        JSON.stringify(authoritativeLines),
        authoritativeTotal,
        lockedStatus,
        Number(locked.inventory_authority_version),
      );
      if (!updated.length) {
        throw AppError.conflict(
          'Order changed during delivery dispatch staging',
          'PHARMACY_ORDER_DISPATCH_STATE_CHANGED',
        );
      }
      return {
        ...updated[0],
        patient_phone: locked.patient_phone,
        items_sha256: stagedClinicalHash,
      };
    });
    const fundingPreparation = await materializePharmacyFundingAuthority({
      tenantId: req.tenantId,
      orderId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
    });
    if (fundingPreparation?.status !== 'funded') {
      throw AppError.conflict(
        'Posted payment or exact TPA funding must be completed before courier custody',
        'PHARMACY_DELIVERY_FUNDING_REQUIRED',
        {
          next_action: fundingPreparation?.fundingRecovery
            ? 'open_exact_pharmacy_funding_task'
            : 'materialize_pharmacy_funding',
          materialize_path: `/api/v1/billing/v2/pharmacy-funding/orders/${orderId}/materialize`,
          funding_recovery: fundingPreparation?.fundingRecovery || null,
        },
      );
    }
    const order = [stagedOrder];
    const fromStatus = stagedOrder.status;

    let eta = { estimated_mins: null, distance_km: null };
    try {
      eta = calculateETA(order[0].delivery_lat, order[0].delivery_lng) || eta;
    } catch (e) {
      logger.warn('calculateETA failed:', e.message);
    }

    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const facilityActor = await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      const verification = await assertVerificationClearedTx(tx, {
        orderId: parseInt(id, 10),
        tenantId: req.tenantId,
      });
      const lockedOrders = await tx.$queryRawUnsafe(
        `SELECT pharmacy_order.*, patient.uid AS patient_uid,
                patient.phone AS canonical_patient_phone
           FROM pharmacy_orders pharmacy_order
           JOIN users patient
             ON patient.tenant_id=pharmacy_order.tenant_id
            AND patient.id=pharmacy_order.patient_id
            AND patient.role='PATIENT' AND patient.is_active=TRUE
            AND patient.status='active' AND patient.is_deleted=FALSE
            AND patient.merged_into_uid IS NULL
          WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
            AND pharmacy_order.facility_id=$3::int
          FOR UPDATE OF pharmacy_order, patient`,
        req.tenantId,
        orderId,
        facility.id,
      );
      if (!lockedOrders[0]) throw AppError.notFound('Order not found');
      const lockedOrder = lockedOrders[0];
      const lockedFromStatus = String(lockedOrder.status || '').toUpperCase();
      if (!validStatuses.includes(lockedFromStatus)) {
        throw AppError.conflict(
          `Order cannot be dispatched from status ${lockedFromStatus || 'unknown'}`,
          'PHARMACY_ORDER_DISPATCH_WRONG_STATUS',
          { current_status: lockedFromStatus || null, allowed_statuses: validStatuses },
        );
      }
      if (verification.delivery_type !== 'delivery') {
        throw AppError.conflict(
          'Counter orders cannot enter the delivery dispatch workflow',
          'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
        );
      }
      const lockedItemsSha256 = clinicalOrderItemsSha256(lockedOrder.items_list);
      if (Number(lockedOrder.inventory_authority_version)
          !== Number(stagedOrder.inventory_authority_version)
          || lockedItemsSha256 !== stagedOrder.items_sha256
          || Math.abs(Number(lockedOrder.total_amount || 0)
            - Number(stagedOrder.total_amount || 0)) > 0.001) {
        throw AppError.conflict(
          'The staged delivery tuple changed before courier custody',
          'PHARMACY_DELIVERY_STAGED_AUTHORITY_STALE',
        );
      }
      const assignees = await tx.$queryRawUnsafe(
        `SELECT courier.uid, courier.id, courier.name AS user_name, courier.phone,
                staff.name AS staff_name
           FROM users courier
           JOIN staff
             ON staff.tenant_id=courier.tenant_id AND staff.user_id=courier.uid
            AND staff.is_active=TRUE AND staff.archived=FALSE
           JOIN pharmacy_staff_facility_grants facility_grant
             ON facility_grant.tenant_id=courier.tenant_id
            AND facility_grant.staff_uid=courier.uid
            AND facility_grant.facility_id=$3::int
            AND facility_grant.status='active' AND facility_grant.revoked_at IS NULL
          WHERE courier.tenant_id=$1::uuid AND courier.uid=$2::uuid
            AND courier.role='DELIVERY_STAFF'
            AND courier.is_active=TRUE AND courier.status='active'
            AND courier.is_deleted=FALSE AND courier.merged_into_uid IS NULL
          FOR UPDATE OF courier, staff, facility_grant`,
        req.tenantId,
        deliveryAssigneeUid,
        facility.id,
      );
      if (assignees.length !== 1) {
        throw AppError.conflict(
          'The assigned courier is not an active delivery staff member granted to this pharmacy facility',
          'PHARMACY_DELIVERY_ASSIGNEE_UNAUTHORISED',
        );
      }
      const courierName = String(assignees[0].staff_name || assignees[0].user_name || '').trim();
      if (!courierName) {
        throw AppError.conflict(
          'The assigned courier has no canonical roster name',
          'PHARMACY_DELIVERY_ASSIGNEE_UNAUTHORISED',
        );
      }
      const funding = await resolveAuthoritativeCounterFundingTx(tx, {
        tenantId: req.tenantId,
        patientId: Number(lockedOrder.patient_id),
        orderId,
        paymentMode: String(lockedOrder.payment_mode || '').trim().toLowerCase(),
        totalAmount: Number(lockedOrder.total_amount || 0),
        orderVersion: Number(lockedOrder.inventory_authority_version),
        orderItemsSha256: lockedItemsSha256,
      });
      const capProbe = await assertPharmacyCapForDispenseTx(tx, {
        tenantId: req.tenantId,
        patientId: Number(lockedOrder.patient_id),
        patientUid: lockedOrder.patient_uid,
        additionalAmount: Number(lockedOrder.total_amount || 0),
        allowOverride: dispatchCapOverride != null,
        orderId,
        facilityId: facility.id,
        actorUid: facilityActor.actor_uid,
        actorRole: facilityActor.actor_role,
        commandKeySha256: command.commandKeySha256,
        fundingSource: funding.fundingSource,
        fundingReference: funding.fundingReference,
        fundingTpaClaimId: funding.fundingTpaClaimId,
        authorisedFundingAmount: funding.fundedAmount,
      });
      const inventory = await allocateOrderInventoryTx(tx, {
        tenantId: req.tenantId,
        order: lockedOrder,
        lines: Array.isArray(lockedOrder.items_list) ? lockedOrder.items_list : [],
        actorUid: facilityActor.actor_uid,
        actorRole: facilityActor.actor_role,
        commandKeySha256: command.commandKeySha256,
        operation: 'delivery',
      });
      if (inventory.prescription) {
        await applyOrderPrescriptionProjectionTx(tx, {
          tenantId: req.tenantId,
          prescription: inventory.prescription,
        });
      }
      const dispensedTotal = Number(inventory.lines
        .reduce((sum, line) => sum + Number(line.line_total || 0), 0)
        .toFixed(2));
      if (Math.abs(dispensedTotal - Number(lockedOrder.total_amount || 0)) > 0.001) {
        throw AppError.conflict(
          'Inventory allocation changed the posted funding total',
          'PHARMACY_DELIVERY_FUNDING_AUTHORITY_STALE',
        );
      }
      const notificationPayload = {
        type: 'pharmacy_order_delivery_handoff',
        pharmacy_order_id: orderId,
        order_number: lockedOrder.order_number || null,
        delivery_assignee_uid: deliveryAssigneeUid,
        handoff_token: handoffToken,
        expires_at: new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString(),
      };
      const patientNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_handoff',
        recipientId: Number(lockedOrder.patient_id),
        title: 'Pharmacy order dispatched',
        body: `Your pharmacy order ${lockedOrder.order_number || orderId} is ready for courier handoff. Share the one-time code only after receiving the sealed package: ${handoffToken}`,
        data: notificationPayload,
        sourceEventKey: `pharmacy-delivery-handoff:${orderId}:1:inapp`,
        templateVersion: 'pharmacy.delivery_handoff.v1',
      }, { tx, strict: true });
      const smsNotice = lockedOrder.canonical_patient_phone
        ? await notificationOutbox.queue({
          tenantId: req.tenantId,
          channel: 'sms',
          type: 'sms',
          recipientId: Number(lockedOrder.patient_id),
          recipientPhone: lockedOrder.canonical_patient_phone,
          title: 'Pharmacy order dispatched',
          body: `Your medicines (${lockedOrder.order_number || orderId}) have been dispatched. Give this one-time handoff code to the assigned courier only after receiving the sealed package: ${handoffToken}`,
          data: notificationPayload,
          sourceEventKey: `pharmacy-delivery-handoff:${orderId}:1:sms`,
          templateVersion: 'sms.pharmacy_delivery_handoff.v1',
        }, { tx, strict: true })
        : null;
      const courierNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_assignment',
        recipientId: Number(assignees[0].id),
        title: 'Pharmacy delivery assigned',
        body: `Pharmacy order ${lockedOrder.order_number || orderId} is assigned to you. Confirm the sealed package and collect the patient handoff code only at delivery.`,
        data: {
          type: 'pharmacy_delivery_assignment',
          pharmacy_order_id: orderId,
          order_number: lockedOrder.order_number || null,
          facility_id: facility.id,
          handoff_generation: 1,
        },
        sourceEventKey: `pharmacy-delivery-assignment:${orderId}:1:inapp`,
        templateVersion: 'pharmacy.delivery_assignment.v1',
      }, { tx, strict: true });
      if (!patientNotice?.id || !courierNotice?.id) {
        throw AppError.serviceUnavailable(
          'The patient handoff and courier assignment notices could not be durably queued',
          'PHARMACY_DELIVERY_HANDOFF_NOTICE_REQUIRED',
        );
      }
      const handoffGeneration = 1;
      const handoffNoticeOutboxIds = [
        patientNotice.id,
        smsNotice?.id,
        courierNotice?.id,
      ].filter(Boolean);
      const updated = await tx.$queryRawUnsafe(`
        UPDATE pharmacy_orders SET
          status='DISPATCHED', dispatched_at=NOW(), dispatched_by=$1,
          delivery_person=$2, delivery_person_phone=$3,
          estimated_delivery_mins=$4, delivery_distance_km=$5,
          delivery_started_at=NOW(), delivery_tracking_active=FALSE,
          delivery_assignee_uid=$10::uuid,
          delivery_handoff_token_sha256=$11,
          delivery_handoff_expires_at=NOW()+INTERVAL '8 hours',
          delivery_handoff_consumed_at=NULL,
          delivery_handoff_completed_by=NULL,
          delivery_handoff_generation=$17::int,
          delivery_handoff_notice_outbox_ids=$18::int[],
          delivery_custody_status='in_transit',
          delivery_custody_contract_version=1,
          items_list=$12::jsonb,
          dispensed_medications=$12::jsonb,
          total_amount=$13::numeric,
          payment_status='paid', amount_collected=$14::numeric,
          payment_metadata=COALESCE(payment_metadata, '{}'::jsonb) || $15::jsonb,
          pack_barcode=COALESCE(pack_barcode, $16),
          sla_delivery_target=NOW()+INTERVAL '2 hours', updated_at=NOW()
        WHERE id=$6 AND tenant_id=$8::uuid AND facility_id=$9::int AND status=$7
        RETURNING id, uid, tenant_id, patient_id, patient_name, status, delivery_person,
          delivery_person_phone, delivery_assignee_uid, dispatched_at, total_amount,
          created_at, updated_at, order_number, items_list, dispensed_medications,
          payment_mode, payment_status, amount_collected, payment_metadata, pack_barcode,
          facility_id, inventory_authority_version, delivery_handoff_token_sha256,
          delivery_handoff_generation, delivery_handoff_notice_outbox_ids,
          delivery_custody_status
      `,
        staffId,
        courierName,
        assignees[0].phone || null,
        eta.estimated_mins,
        eta.distance_km,
        parseInt(id),
        lockedFromStatus,
        req.tenantId,
        facility.id,
        deliveryAssigneeUid,
        handoffTokenSha256,
        JSON.stringify(inventory.lines),
        dispensedTotal,
        Number(funding.collectedAmount || 0),
        JSON.stringify({
          contract: 'pharmacy_delivery_funding_projection_v1',
          funding_source: funding.fundingSource,
          funding_reference: funding.fundingReference,
          funding_tpa_claim_id: funding.fundingTpaClaimId,
          funded_amount: funding.fundedAmount,
          payment_ids: funding.paymentIds || [],
          funding_authority: funding.authorityEvidence || null,
          dispatch_command_sha256: command.commandKeySha256,
        }),
        `VHMP-${orderId}-${command.commandKeySha256.slice(0, 8).toUpperCase()}`,
        handoffGeneration,
        handoffNoticeOutboxIds,
      );
      if (!updated.length) return null;

      const packageEvidence = pharmacyDeliveryPackageEvidence(updated[0]);
      await appendPharmacyDeliveryCustodyEventTx(tx, {
        tenantId: req.tenantId,
        orderId,
        facilityId: facility.id,
        eventType: 'PACKAGE_ISSUED',
        actorUid: facilityActor.actor_uid,
        actorRole: facilityActor.actor_role,
        commandKeySha256: command.commandKeySha256,
        requestSha256: command.requestSha256,
        orderAuthorityVersion: updated[0].inventory_authority_version,
        orderItemsSha256: lockedItemsSha256,
        handoffGeneration,
        handoffTokenSha256,
        notificationOutboxIds: handoffNoticeOutboxIds,
        inventoryEvidence: packageEvidence.inventoryEvidence,
        fundingEvidence: packageEvidence.fundingEvidence,
        custodyEvidence: {
          contract: 'pharmacy_delivery_custody_v1',
          from_status: lockedFromStatus,
          to_status: 'DISPATCHED',
          delivery_assignee_uid: deliveryAssigneeUid,
          package_barcode: updated[0].pack_barcode,
        },
      });

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role)
         VALUES ($1::uuid, $2, $3, 'DISPATCHED', $4, $5)`,
        req.tenantId, parseInt(id), lockedFromStatus,
        facilityActor.actor_id, facilityActor.actor_role.toLowerCase(),
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_dispatched', updated[0], {
        from_status: lockedFromStatus,
        to_status: 'DISPATCHED',
        delivery_assignee_uid: deliveryAssigneeUid,
        inventory_allocations: inventory.allocations,
        funding_authority: funding.authorityEvidence,
        cap_authority: capProbe,
        handoff_notice_outbox_ids: handoffNoticeOutboxIds,
        performer: facilityActor,
      });
      updated[0].inventory_allocations = inventory.allocations;
      updated[0].funding_authority = funding.authorityEvidence;
      updated[0].handoff_notice_outbox_ids = handoffNoticeOutboxIds;
      const payload = await storeOrderCommandReceiptTx(
        tx, req, orderId, command, updated[0], 'Order dispatched',
      );
      return { replay: false, payload, fromStatus: lockedFromStatus };
    });

    if (!result) {
      throw AppError.conflict(
        'Order status changed before dispatch',
        'PHARMACY_ORDER_DISPATCH_STATE_CHANGED',
      );
    }

    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_DISPATCHED', result.payload, {
      from_status: result.fromStatus || fromStatus,
      to_status: 'DISPATCHED',
      delivery_assignee_uid: deliveryAssigneeUid,
    });
    success(res, result.payload, 'Order dispatched');
  } catch (err) {
    return relayAppError(res, err, 'Failed to dispatch order');
  }
};

export const markDelivered = async (req, res) => {
  try {
    const orderId = pharmacyOrderIdOrNull(req.params.id);
    if (!orderId) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const commandKeySha256 = dispenseCommandKey(req, `delivered:${orderId}`);
    const command = {
      action: 'delivered',
      commandKeySha256,
      requestSha256: pharmacyCommandRequestSha256(req.body || {}),
    };
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Delivered',
    );
    const actorUid = String(req.user?.uid || '').trim();
    const actorRole = String(req.user?.role || '').trim().toUpperCase();
    const handoffToken = String(req.body?.handoff_token || '').trim();
    const breakGlassReason = String(req.body?.break_glass_reason || '').trim();
    const isBreakGlass = actorRole === 'PHARMACY_INCHARGE';
    const forbiddenDeliveryFields = [
      'dispensed_items', 'payment_mode', 'amount_collected', 'tpa_reference',
      'cap_override', 'cap_override_reason',
    ].filter((field) => Object.hasOwn(req.body || {}, field));
    if (forbiddenDeliveryFields.length) {
      throw AppError.badRequest(
        'Delivery completion consumes only the staged custody package and patient handoff proof',
        'PHARMACY_DELIVERY_CALLER_AUTHORITY_FORBIDDEN',
        { forbidden_fields: forbiddenDeliveryFields },
      );
    }
    if (!UUID_RE.test(actorUid) || !['DELIVERY_STAFF', 'PHARMACY_INCHARGE'].includes(actorRole)) {
      throw AppError.forbidden(
        'Only the assigned courier or pharmacy in-charge may complete delivery',
        'PHARMACY_DELIVERY_ACTOR_UNAUTHORISED',
      );
    }
    if (!handoffToken || handoffToken.length < 20 || handoffToken.length > 200) {
      throw AppError.badRequest(
        'A valid one-time patient handoff token is required',
        'PHARMACY_DELIVERY_HANDOFF_PROOF_REQUIRED',
      );
    }
    if (isBreakGlass && (breakGlassReason.length < 10 || breakGlassReason.length > 500)) {
      throw AppError.badRequest(
        'Pharmacy in-charge break-glass delivery requires a 10 to 500 character reason',
        'PHARMACY_DELIVERY_BREAK_GLASS_REASON_REQUIRED',
      );
    }
    const handoffTokenSha256 = deliveryHandoffSha256(req.tenantId, orderId, handoffToken);
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const facilityActor = await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      const verification = await assertVerificationClearedTx(tx, {
        orderId,
        tenantId: req.tenantId,
      });
      if (verification.delivery_type !== 'delivery') {
        throw AppError.conflict(
          'Only delivery orders can complete the delivery workflow',
          'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
        );
      }
      const locked = await tx.$queryRawUnsafe(
        `SELECT *
           FROM pharmacy_orders
          WHERE id=$1::int AND tenant_id=$2::uuid AND facility_id=$3::int
            AND status='DISPATCHED' AND delivery_custody_status='in_transit'
            AND delivery_custody_contract_version=1
            AND delivery_handoff_token_sha256=$4
            AND delivery_handoff_consumed_at IS NULL
            AND delivery_handoff_expires_at>NOW()
            AND (delivery_assignee_uid=$5::uuid OR $6::boolean=TRUE)
            AND NOT EXISTS (
              SELECT 1
                FROM pharmacy_inventory_authority_recovery_worklist recovery
               WHERE recovery.tenant_id=pharmacy_orders.tenant_id
                 AND recovery.entity_type='pharmacy_order'
                 AND recovery.entity_id=pharmacy_orders.id
                 AND recovery.reason_code='ORDER_DELIVERY_CUSTODY_UNRESOLVED'
                 AND recovery.status='OPEN'
            )
          FOR UPDATE`,
        orderId,
        req.tenantId,
        facility.id,
        handoffTokenSha256,
        actorUid,
        isBreakGlass,
      );
      if (!locked.length) return null;
      const order = locked[0];
      const deliveryLines = Array.isArray(order.items_list) ? order.items_list : [];
      const inventoryEvidenceComplete = deliveryLines.length > 0 && deliveryLines.every((line) => {
        const ordered = Number(line?.ordered_qty ?? line?.quantity ?? line?.qty);
        const dispensed = Number(line?.inventory_dispensed_quantity || 0);
        return Number.isFinite(ordered) && ordered > 0
          && Number.isFinite(dispensed) && dispensed + 0.000001 >= ordered
          && Array.isArray(line?.inventory_allocation_evidence)
          && line.inventory_allocation_evidence.length > 0;
      });
      if (!inventoryEvidenceComplete
          || order.payment_status !== 'paid'
          || order.payment_metadata?.contract !== 'pharmacy_delivery_funding_projection_v1') {
        throw AppError.conflict(
          'The dispatched package has no complete inventory and posted funding custody receipt',
          'PHARMACY_DELIVERY_DISPATCH_RECEIPT_REQUIRED',
        );
      }
      const movementIds = [...new Set(deliveryLines.flatMap((line) => (
        line.inventory_allocation_evidence.map((entry) => Number(entry?.movement_id))
      )).filter((movementId) => Number.isSafeInteger(movementId) && movementId > 0))];
      const movementRows = await tx.$queryRawUnsafe(
        `SELECT movement.id
           FROM pharmacy_stock_movements movement
           JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id=movement.tenant_id
            AND batch.id=movement.inventory_batch_id
            AND batch.inventory_item_id=movement.inventory_item_id
           JOIN pharmacy_inventory_items item
             ON item.tenant_id=movement.tenant_id
            AND item.id=movement.inventory_item_id
            AND item.facility_id=$3::int AND batch.facility_id=item.facility_id
          WHERE movement.tenant_id=$1::uuid AND movement.id=ANY($2::int[])
            AND movement.movement_kind='issue'
            -- An order line's inventory_allocation_evidence can carry THREE
            -- movement shapes, all written by pharmacyOrderInventoryService
            -- against this same order and all stamping metadata.order_id:
            --   pharmacy_order_dispense — ordinary allocation (:1110)
            --   controlled_dispense     — Schedule X / narcotic line, routed
            --                             through dispenseControlledTx (:1083)
            --   dispense_substitution   — pharmacist substitution, appended to
            --                             the same evidence array (:1786/:1877)
            -- Accepting only the first made every order containing a
            -- controlled or substituted line dispatchable but permanently
            -- undeliverable (the count check below always failed).
            AND movement.reference_type IN (
              'pharmacy_order_dispense', 'controlled_dispense', 'dispense_substitution'
            )
            AND (movement.metadata->>'order_id')::int=$4::int
          ORDER BY movement.id
          FOR UPDATE OF movement, batch, item`,
        req.tenantId,
        movementIds,
        facility.id,
        orderId,
      );
      if (movementIds.length === 0 || movementRows.length !== movementIds.length) {
        throw AppError.conflict(
          'The exact dispatched stock movement receipt is missing or stale',
          'PHARMACY_DELIVERY_DISPATCH_RECEIPT_REQUIRED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders SET status='DELIVERED', delivered_at=NOW(),
           delivery_tracking_active=FALSE,
           delivery_handoff_consumed_at=NOW(),
           delivery_handoff_completed_by=$4::uuid,
           delivery_custody_status='delivered',
           updated_at=NOW()
         WHERE id=$1::int AND tenant_id=$2::uuid AND facility_id=$3::int
           AND status='DISPATCHED' AND delivery_custody_status='in_transit'
           AND delivery_handoff_consumed_at IS NULL
         RETURNING id, uid, tenant_id, patient_id, patient_name, status, order_note,
           total_amount, patient_phone, items_list, dispensed_medications, facility_id,
           delivered_at, created_at, updated_at, order_number, payment_mode,
           payment_status, amount_collected, payment_metadata, delivery_assignee_uid,
           delivery_handoff_completed_by, delivery_custody_status, pack_barcode`,
        orderId,
        req.tenantId,
        facility.id,
        actorUid,
      );
      if (!updated.length) return null;
      const deliveredOrder = updated[0];
      deliveredOrder.inventory_allocations = deliveryLines.flatMap(
        (line) => line.inventory_allocation_evidence,
      );
      order.dispense_label = {
        order_number: order.order_number,
        patient_name: order.patient_name,
        dispensed_at: order.dispatched_at,
        partial_dispense: false,
        items: deliveryLines,
        inventory_allocations: deliveredOrder.inventory_allocations,
      };
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_orders
            SET dispense_label=$3::jsonb, updated_at=NOW()
          WHERE id=$1::int AND tenant_id=$2::uuid AND facility_id=$4::int`,
        orderId,
        req.tenantId,
        JSON.stringify(order.dispense_label),
        order.facility_id,
      );
      const patientDeliveryNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_completed',
        recipientId: Number(order.patient_id),
        title: 'Pharmacy delivery completed',
        body: `Pharmacy order ${order.order_number || orderId} was handed over and its one-time code is now closed.`,
        data: {
          pharmacy_order_id: orderId,
          facility_id: order.facility_id,
          handoff_generation: order.delivery_handoff_generation,
        },
        sourceEventKey: `pharmacy-delivery-completed:${orderId}:${order.delivery_handoff_generation}`,
        templateVersion: 'pharmacy.delivery_completed.v1',
      }, { tx, strict: true });
      if (!patientDeliveryNotice?.id) {
        throw AppError.serviceUnavailable(
          'The patient delivery-completion notice could not be durably queued',
          'PHARMACY_DELIVERY_COMPLETION_NOTICE_REQUIRED',
        );
      }
      const packageEvidence = pharmacyDeliveryPackageEvidence(order);
      await appendPharmacyDeliveryCustodyEventTx(tx, {
        tenantId: req.tenantId,
        orderId,
        facilityId: order.facility_id,
        eventType: 'DELIVERED',
        actorUid,
        actorRole,
        commandKeySha256: command.commandKeySha256,
        requestSha256: command.requestSha256,
        orderAuthorityVersion: order.inventory_authority_version,
        orderItemsSha256: clinicalOrderItemsSha256(order.items_list),
        handoffGeneration: order.delivery_handoff_generation,
        handoffTokenSha256: order.delivery_handoff_token_sha256,
        notificationOutboxIds: [patientDeliveryNotice.id],
        inventoryEvidence: packageEvidence.inventoryEvidence,
        fundingEvidence: packageEvidence.fundingEvidence,
        custodyEvidence: {
          contract: 'pharmacy_delivery_custody_v1',
          from_status: 'DISPATCHED',
          to_status: 'DELIVERED',
          delivery_assignee_uid: order.delivery_assignee_uid,
          delivery_completed_by: actorUid,
          inventory_movement_ids: movementIds,
          dispatch_command_sha256: order.payment_metadata?.dispatch_command_sha256,
          patient_notice_outbox_id: patientDeliveryNotice.id,
        },
        reason: isBreakGlass ? breakGlassReason : null,
      });
      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
           (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2, 'DISPATCHED', 'DELIVERED', $3, $4, $5)`,
        req.tenantId,
        orderId,
        facilityActor.actor_id,
        facilityActor.actor_role.toLowerCase(),
        isBreakGlass ? `Delivery break glass: ${breakGlassReason}` : null,
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_delivered', deliveredOrder, {
        from_status: 'DISPATCHED',
        to_status: 'DELIVERED',
        delivery_assignee_uid: order.delivery_assignee_uid,
        delivery_completed_by: actorUid,
        delivery_break_glass_reason: isBreakGlass ? breakGlassReason : null,
        inventory_movement_ids: movementIds,
        dispatch_command_sha256: order.payment_metadata?.dispatch_command_sha256 || null,
        patient_notice_outbox_id: patientDeliveryNotice.id,
        performer: facilityActor,
      });
      deliveredOrder.patient_notice_outbox_id = patientDeliveryNotice.id;
      const payload = await storeOrderCommandReceiptTx(
        tx, req, orderId, command, deliveredOrder, 'Delivered',
      );
      return { replay: false, payload };
    });

    if (!result) {
      throw AppError.conflict(
        'Order must be DISPATCHED before delivery completion',
        'PHARMACY_ORDER_DELIVERY_WRONG_STATUS',
      );
    }

    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_DELIVERED', result.payload, {
      from_status: 'DISPATCHED',
      to_status: 'DELIVERED',
      delivery_completed_by: actorUid,
      delivery_break_glass_reason: isBreakGlass ? breakGlassReason : null,
    });
    success(res, result.payload, 'Delivered');
  } catch (err) {
    logger.error('Mark delivered error:', err);
    return relayAppError(res, err, 'Failed to update order');
  }
};

function deliveryCustodyReason(value, label) {
  const reason = stripHtml(String(value || '')).trim();
  if (reason.length < 10 || reason.length > 500) {
    throw AppError.badRequest(
      `${label} must contain 10 to 500 characters`,
      'PHARMACY_DELIVERY_CUSTODY_REASON_REQUIRED',
    );
  }
  return reason;
}

async function assertCurrentDeliveryHandoffEventTx(tx, order) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, event_type, handoff_generation, handoff_token_sha256
       FROM pharmacy_delivery_custody_events
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        AND handoff_generation=$3::int
        AND event_type IN ('PACKAGE_ISSUED','HANDOFF_REISSUED','HANDOFF_ROTATED')
      ORDER BY id
      FOR SHARE`,
    order.tenant_id,
    Number(order.id),
    Number(order.delivery_handoff_generation),
  );
  if (rows.length !== 1
      || rows[0].handoff_token_sha256 !== order.delivery_handoff_token_sha256) {
    throw AppError.conflict(
      'The current delivery handoff has no single exact custody issue event',
      'PHARMACY_DELIVERY_CUSTODY_EVENT_REQUIRED',
    );
  }
  return rows[0];
}

export const reissueDeliveryHandoff = async (req, res) => {
  try {
    const orderId = requirePharmacyOrderId(req.params.id);
    const actorUid = String(req.user?.uid || '').trim();
    const actorRole = String(req.user?.role || '').trim().toUpperCase();
    if (!UUID_RE.test(actorUid) || actorRole !== 'PHARMACY_INCHARGE') {
      throw AppError.forbidden(
        'Only the pharmacy in-charge may rotate an active delivery handoff',
        'PHARMACY_DELIVERY_HANDOFF_REISSUE_FORBIDDEN',
      );
    }
    const reason = deliveryCustodyReason(req.body?.reason, 'reason');
    const requestedAssigneeUid = req.body?.delivery_assignee_uid == null
      ? null
      : String(req.body.delivery_assignee_uid).trim();
    if (requestedAssigneeUid != null && !UUID_RE.test(requestedAssigneeUid)) {
      throw AppError.badRequest(
        'delivery_assignee_uid must identify an active courier',
        'PHARMACY_DELIVERY_ASSIGNEE_REQUIRED',
      );
    }
    const command = pharmacyOrderCommand(req, orderId, 'delivery-handoff-reissue');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Delivery handoff reissued',
    );
    const handoffToken = randomBytes(24).toString('base64url');
    const handoffTokenSha256 = deliveryHandoffSha256(req.tenantId, orderId, handoffToken);
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const facilityActor = await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      const orders = await tx.$queryRawUnsafe(
        `SELECT pharmacy_order.*, patient.phone AS canonical_patient_phone
           FROM pharmacy_orders pharmacy_order
           JOIN users patient
             ON patient.tenant_id=pharmacy_order.tenant_id
            AND patient.id=pharmacy_order.patient_id
            AND patient.role='PATIENT' AND patient.is_active=TRUE
            AND patient.status='active' AND patient.is_deleted=FALSE
            AND patient.merged_into_uid IS NULL
          WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
            AND pharmacy_order.facility_id=$3::int
            AND pharmacy_order.status='DISPATCHED'
            AND pharmacy_order.delivery_custody_status='in_transit'
            AND pharmacy_order.delivery_handoff_consumed_at IS NULL
          FOR UPDATE OF pharmacy_order, patient`,
        req.tenantId,
        orderId,
        facility.id,
      );
      if (!orders[0]) return null;
      const order = orders[0];
      await assertCurrentDeliveryHandoffEventTx(tx, order);
      const deliveryAssigneeUid = requestedAssigneeUid || order.delivery_assignee_uid;
      const assignees = await tx.$queryRawUnsafe(
        `SELECT courier.id, courier.uid, courier.phone,
                COALESCE(NULLIF(BTRIM(staff.name), ''), courier.name) AS name
           FROM users courier
           JOIN staff
             ON staff.tenant_id=courier.tenant_id AND staff.user_id=courier.uid
            AND staff.is_active=TRUE AND staff.archived=FALSE
           JOIN pharmacy_staff_facility_grants facility_grant
             ON facility_grant.tenant_id=courier.tenant_id
            AND facility_grant.staff_uid=courier.uid
            AND facility_grant.facility_id=$3::int
            AND facility_grant.status='active' AND facility_grant.revoked_at IS NULL
          WHERE courier.tenant_id=$1::uuid AND courier.uid=$2::uuid
            AND courier.role='DELIVERY_STAFF' AND courier.is_active=TRUE
            AND courier.status='active' AND courier.is_deleted=FALSE
            AND courier.merged_into_uid IS NULL
          FOR UPDATE OF courier, staff, facility_grant`,
        req.tenantId,
        deliveryAssigneeUid,
        facility.id,
      );
      if (assignees.length !== 1) {
        throw AppError.conflict(
          'The replacement courier is not active and granted to this pharmacy facility',
          'PHARMACY_DELIVERY_ASSIGNEE_UNAUTHORISED',
        );
      }
      const nextGeneration = Number(order.delivery_handoff_generation) + 1;
      const patientPayload = {
        type: 'pharmacy_order_delivery_handoff',
        pharmacy_order_id: orderId,
        order_number: order.order_number || null,
        delivery_assignee_uid: deliveryAssigneeUid,
        handoff_generation: nextGeneration,
        handoff_token: handoffToken,
        expires_at: new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString(),
      };
      const patientNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_handoff',
        recipientId: Number(order.patient_id),
        title: 'Pharmacy delivery handoff updated',
        body: `The one-time handoff code for pharmacy order ${order.order_number || orderId} has changed. Share the new code only after receiving the sealed package: ${handoffToken}`,
        data: patientPayload,
        sourceEventKey: `pharmacy-delivery-handoff:${orderId}:${nextGeneration}:inapp`,
        templateVersion: 'pharmacy.delivery_handoff.v1',
      }, { tx, strict: true });
      const smsNotice = order.canonical_patient_phone
        ? await notificationOutbox.queue({
          tenantId: req.tenantId,
          channel: 'sms',
          type: 'sms',
          recipientId: Number(order.patient_id),
          recipientPhone: order.canonical_patient_phone,
          title: 'Pharmacy delivery handoff updated',
          body: `Your new one-time handoff code for medicines ${order.order_number || orderId} is ${handoffToken}. Share it only after receiving the sealed package.`,
          data: patientPayload,
          sourceEventKey: `pharmacy-delivery-handoff:${orderId}:${nextGeneration}:sms`,
          templateVersion: 'sms.pharmacy_delivery_handoff.v1',
        }, { tx, strict: true })
        : null;
      const courierNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_assignment',
        recipientId: Number(assignees[0].id),
        title: 'Pharmacy delivery handoff updated',
        body: `Pharmacy order ${order.order_number || orderId} is assigned to you under handoff generation ${nextGeneration}. Collect the patient code only at delivery.`,
        data: {
          type: 'pharmacy_delivery_assignment',
          pharmacy_order_id: orderId,
          order_number: order.order_number || null,
          facility_id: facility.id,
          handoff_generation: nextGeneration,
        },
        sourceEventKey: `pharmacy-delivery-assignment:${orderId}:${nextGeneration}:inapp`,
        templateVersion: 'pharmacy.delivery_assignment.v1',
      }, { tx, strict: true });
      const noticeIds = [patientNotice?.id, smsNotice?.id, courierNotice?.id].filter(Boolean);
      if (!patientNotice?.id || !courierNotice?.id) {
        throw AppError.serviceUnavailable(
          'The replacement handoff notices could not be durably queued',
          'PHARMACY_DELIVERY_HANDOFF_NOTICE_REQUIRED',
        );
      }
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.pharmacy_delivery_handoff_reissue', 'on', TRUE)`,
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET delivery_person=$4,
                delivery_person_phone=$5,
                delivery_assignee_uid=$6::uuid,
                delivery_handoff_token_sha256=$7,
                delivery_handoff_expires_at=NOW()+INTERVAL '8 hours',
                delivery_handoff_generation=$8::int,
                delivery_handoff_notice_outbox_ids=$9::int[],
                delivery_tracking_active=FALSE,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
            AND status='DISPATCHED' AND delivery_custody_status='in_transit'
            AND delivery_handoff_consumed_at IS NULL
            AND delivery_handoff_generation=$10::int
          RETURNING *`,
        req.tenantId,
        orderId,
        facility.id,
        assignees[0].name,
        assignees[0].phone || null,
        deliveryAssigneeUid,
        handoffTokenSha256,
        nextGeneration,
        noticeIds,
        Number(order.delivery_handoff_generation),
      );
      if (!updated[0]) return null;
      const packageEvidence = pharmacyDeliveryPackageEvidence(updated[0]);
      const rotated = deliveryAssigneeUid !== order.delivery_assignee_uid;
      await appendPharmacyDeliveryCustodyEventTx(tx, {
        tenantId: req.tenantId,
        orderId,
        facilityId: facility.id,
        eventType: rotated ? 'HANDOFF_ROTATED' : 'HANDOFF_REISSUED',
        actorUid,
        actorRole,
        commandKeySha256: command.commandKeySha256,
        requestSha256: command.requestSha256,
        orderAuthorityVersion: updated[0].inventory_authority_version,
        orderItemsSha256: clinicalOrderItemsSha256(updated[0].items_list),
        handoffGeneration: nextGeneration,
        handoffTokenSha256,
        notificationOutboxIds: noticeIds,
        inventoryEvidence: packageEvidence.inventoryEvidence,
        fundingEvidence: packageEvidence.fundingEvidence,
        custodyEvidence: {
          contract: 'pharmacy_delivery_custody_v1',
          prior_handoff_generation: Number(order.delivery_handoff_generation),
          prior_delivery_assignee_uid: order.delivery_assignee_uid,
          delivery_assignee_uid: deliveryAssigneeUid,
          rotated,
        },
        reason,
      });
      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
           (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, 'DISPATCHED', 'DISPATCHED', $3, $4, $5)`,
        req.tenantId,
        orderId,
        facilityActor.actor_id,
        facilityActor.actor_role.toLowerCase(),
        `${rotated ? 'Delivery handoff rotated' : 'Delivery handoff reissued'}: ${reason}`,
      );
      await emitPharmacyOrderEventInTx(
        tx,
        req,
        rotated ? 'pharmacy.delivery_handoff_rotated' : 'pharmacy.delivery_handoff_reissued',
        updated[0],
        {
          from_status: 'DISPATCHED',
          to_status: 'DISPATCHED',
          handoff_generation: nextGeneration,
          delivery_assignee_uid: deliveryAssigneeUid,
          reason,
          performer: facilityActor,
        },
      );
      const payload = await storeOrderCommandReceiptTx(
        tx,
        req,
        orderId,
        command,
        {
          id: updated[0].id,
          status: updated[0].status,
          delivery_custody_status: updated[0].delivery_custody_status,
          delivery_assignee_uid: updated[0].delivery_assignee_uid,
          delivery_handoff_generation: updated[0].delivery_handoff_generation,
          delivery_handoff_notice_outbox_ids: updated[0].delivery_handoff_notice_outbox_ids,
        },
        rotated ? 'Delivery handoff rotated' : 'Delivery handoff reissued',
      );
      return { replay: false, payload };
    });
    if (!result) {
      throw AppError.conflict(
        'Only an active, unconsumed in-transit handoff can be reissued',
        'PHARMACY_DELIVERY_HANDOFF_REISSUE_WRONG_STATE',
      );
    }
    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_DELIVERY_HANDOFF_REISSUED', result.payload, {
      reason,
      requested_delivery_assignee_uid: requestedAssigneeUid,
    });
    return success(res, result.payload, 'Delivery handoff reissued');
  } catch (err) {
    return relayAppError(res, err, 'Failed to reissue delivery handoff');
  }
};

export const requestDeliveryReturn = async (req, res) => {
  try {
    const orderId = requirePharmacyOrderId(req.params.id);
    const actorUid = String(req.user?.uid || '').trim();
    const actorRole = String(req.user?.role || '').trim().toUpperCase();
    if (!UUID_RE.test(actorUid)
        || !['DELIVERY_STAFF', 'PHARMACY_INCHARGE'].includes(actorRole)) {
      throw AppError.forbidden(
        'Only the assigned courier or pharmacy in-charge may request package return',
        'PHARMACY_DELIVERY_RETURN_FORBIDDEN',
      );
    }
    const reason = deliveryCustodyReason(req.body?.reason, 'reason');
    const command = pharmacyOrderCommand(req, orderId, 'delivery-return-request');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Delivery return requested',
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const facilityActor = await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      const orders = await tx.$queryRawUnsafe(
        `SELECT * FROM pharmacy_orders
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
            AND status='DISPATCHED' AND delivery_custody_status='in_transit'
            AND delivery_handoff_consumed_at IS NULL
            AND (delivery_assignee_uid=$4::uuid OR $5::boolean=TRUE)
          FOR UPDATE`,
        req.tenantId,
        orderId,
        facility.id,
        actorUid,
        actorRole === 'PHARMACY_INCHARGE',
      );
      if (!orders[0]) return null;
      const order = orders[0];
      await assertCurrentDeliveryHandoffEventTx(tx, order);
      const owners = await tx.$queryRawUnsafe(
        `SELECT owner.id, owner.uid
           FROM users owner
           JOIN pharmacy_staff_facility_grants facility_grant
             ON facility_grant.tenant_id=owner.tenant_id
            AND facility_grant.staff_uid=owner.uid
            AND facility_grant.facility_id=$2::int
            AND facility_grant.status='active' AND facility_grant.revoked_at IS NULL
          WHERE owner.tenant_id=$1::uuid AND owner.role='PHARMACY_INCHARGE'
            AND owner.is_active=TRUE AND owner.status='active'
            AND owner.is_deleted=FALSE AND owner.merged_into_uid IS NULL
          ORDER BY owner.id
          FOR SHARE OF owner, facility_grant`,
        req.tenantId,
        facility.id,
      );
      if (!owners.length) {
        throw AppError.conflict(
          'No active pharmacy in-charge is granted to receive this returned package',
          'PHARMACY_DELIVERY_RETURN_OWNER_REQUIRED',
        );
      }
      const patientNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_return_requested',
        recipientId: Number(order.patient_id),
        title: 'Pharmacy package return started',
        body: `Pharmacy order ${order.order_number || orderId} is being returned to the pharmacy. The handoff code can no longer complete delivery.`,
        data: {
          pharmacy_order_id: orderId,
          facility_id: facility.id,
          handoff_generation: order.delivery_handoff_generation,
        },
        sourceEventKey: `pharmacy-delivery-return-patient:${orderId}:${order.delivery_handoff_generation}`,
        templateVersion: 'pharmacy.delivery_return_requested.v1',
      }, { tx, strict: true });
      if (!patientNotice?.id) {
        throw AppError.serviceUnavailable(
          'The patient return notice could not be durably queued',
          'PHARMACY_DELIVERY_RETURN_NOTICE_REQUIRED',
        );
      }
      const noticeIds = [patientNotice.id];
      for (const owner of owners) {
        const notice = await notificationOutbox.queue({
          tenantId: req.tenantId,
          channel: 'inapp',
          type: 'pharmacy_delivery_return_requested',
          recipientId: Number(owner.id),
          title: 'Pharmacy package return requested',
          body: `Return custody was requested for pharmacy order ${order.order_number || orderId}. Receive and classify the sealed package before any further action.`,
          data: {
            pharmacy_order_id: orderId,
            facility_id: facility.id,
            delivery_assignee_uid: order.delivery_assignee_uid,
            handoff_generation: order.delivery_handoff_generation,
          },
          sourceEventKey: `pharmacy-delivery-return:${orderId}:${order.delivery_handoff_generation}:${owner.uid}`,
          templateVersion: 'pharmacy.delivery_return_requested.v1',
        }, { tx, strict: true });
        if (notice?.id) noticeIds.push(notice.id);
      }
      if (!noticeIds.length) {
        throw AppError.serviceUnavailable(
          'The return owner notices could not be durably queued',
          'PHARMACY_DELIVERY_RETURN_NOTICE_REQUIRED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET delivery_custody_status='return_pending',
                delivery_tracking_active=FALSE,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
            AND status='DISPATCHED' AND delivery_custody_status='in_transit'
            AND delivery_handoff_consumed_at IS NULL
          RETURNING *`,
        req.tenantId,
        orderId,
        facility.id,
      );
      if (!updated[0]) return null;
      const packageEvidence = pharmacyDeliveryPackageEvidence(updated[0]);
      await appendPharmacyDeliveryCustodyEventTx(tx, {
        tenantId: req.tenantId,
        orderId,
        facilityId: facility.id,
        eventType: 'RETURN_REQUESTED',
        actorUid,
        actorRole,
        commandKeySha256: command.commandKeySha256,
        requestSha256: command.requestSha256,
        orderAuthorityVersion: updated[0].inventory_authority_version,
        orderItemsSha256: clinicalOrderItemsSha256(updated[0].items_list),
        handoffGeneration: updated[0].delivery_handoff_generation,
        handoffTokenSha256: updated[0].delivery_handoff_token_sha256,
        notificationOutboxIds: noticeIds,
        inventoryEvidence: packageEvidence.inventoryEvidence,
        fundingEvidence: packageEvidence.fundingEvidence,
        custodyEvidence: {
          contract: 'pharmacy_delivery_custody_v1',
          from_custody_status: 'in_transit',
          to_custody_status: 'return_pending',
          delivery_assignee_uid: updated[0].delivery_assignee_uid,
          return_owner_uids: owners.map((owner) => owner.uid),
        },
        reason,
      });
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.delivery_return_requested', updated[0], {
        from_status: 'DISPATCHED',
        to_status: 'DISPATCHED',
        from_custody_status: 'in_transit',
        to_custody_status: 'return_pending',
        reason,
        performer: facilityActor,
      });
      const payload = await storeOrderCommandReceiptTx(
        tx,
        req,
        orderId,
        command,
        {
          id: updated[0].id,
          status: updated[0].status,
          delivery_custody_status: updated[0].delivery_custody_status,
          delivery_handoff_generation: updated[0].delivery_handoff_generation,
          return_notice_outbox_ids: noticeIds,
        },
        'Delivery return requested',
      );
      return { replay: false, payload };
    });
    if (!result) {
      throw AppError.conflict(
        'Only an active in-transit package may enter return custody',
        'PHARMACY_DELIVERY_RETURN_WRONG_STATE',
      );
    }
    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_DELIVERY_RETURN_REQUESTED', result.payload, {
      reason,
    });
    return success(res, result.payload, 'Delivery return requested');
  } catch (err) {
    return relayAppError(res, err, 'Failed to request delivery return');
  }
};

export const completeDeliveryReturn = async (req, res) => {
  try {
    const orderId = requirePharmacyOrderId(req.params.id);
    const actorUid = String(req.user?.uid || '').trim();
    const actorRole = String(req.user?.role || '').trim().toUpperCase();
    if (!UUID_RE.test(actorUid) || actorRole !== 'PHARMACY_INCHARGE') {
      throw AppError.forbidden(
        'Only the pharmacy in-charge may receive and classify a returned package',
        'PHARMACY_DELIVERY_RETURN_COMPLETION_FORBIDDEN',
      );
    }
    const disposition = String(req.body?.disposition || '').trim().toLowerCase();
    if (!['returned', 'quarantined'].includes(disposition)) {
      throw AppError.badRequest(
        'disposition must be returned or quarantined',
        'PHARMACY_DELIVERY_RETURN_DISPOSITION_INVALID',
      );
    }
    const reason = deliveryCustodyReason(req.body?.reason, 'reason');
    const command = pharmacyOrderCommand(req, orderId, `delivery-return-${disposition}`);
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Delivery return completed',
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const facilityActor = await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      const orders = await tx.$queryRawUnsafe(
        `SELECT pharmacy_order.*, patient.phone AS canonical_patient_phone
           FROM pharmacy_orders pharmacy_order
           JOIN users patient
             ON patient.tenant_id=pharmacy_order.tenant_id
            AND patient.id=pharmacy_order.patient_id AND patient.role='PATIENT'
          WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
            AND pharmacy_order.facility_id=$3::int
            AND pharmacy_order.status='DISPATCHED'
            AND pharmacy_order.delivery_custody_status='return_pending'
            AND pharmacy_order.delivery_handoff_consumed_at IS NULL
          FOR UPDATE OF pharmacy_order, patient`,
        req.tenantId,
        orderId,
        facility.id,
      );
      if (!orders[0]) return null;
      const order = orders[0];
      await assertCurrentDeliveryHandoffEventTx(tx, order);
      const pendingEvents = await tx.$queryRawUnsafe(
        `SELECT id
           FROM pharmacy_delivery_custody_events
          WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
            AND handoff_generation=$3::int AND event_type='RETURN_REQUESTED'
          ORDER BY id
          FOR SHARE`,
        req.tenantId,
        orderId,
        Number(order.delivery_handoff_generation),
      );
      if (pendingEvents.length !== 1) {
        throw AppError.conflict(
          'The returned package has no single exact return-request custody event',
          'PHARMACY_DELIVERY_RETURN_EVENT_REQUIRED',
        );
      }
      const patientNotice = await notificationOutbox.queue({
        tenantId: req.tenantId,
        channel: 'inapp',
        type: 'pharmacy_delivery_return_completed',
        recipientId: Number(order.patient_id),
        title: 'Pharmacy delivery closed',
        body: `Pharmacy order ${order.order_number || orderId} was returned to the pharmacy and ${disposition === 'quarantined' ? 'placed in quarantine' : 'closed for pharmacy review'}. Contact the pharmacy for replacement or refund guidance.`,
        data: {
          pharmacy_order_id: orderId,
          facility_id: facility.id,
          custody_disposition: disposition,
          handoff_generation: order.delivery_handoff_generation,
        },
        sourceEventKey: `pharmacy-delivery-return-complete:${orderId}:${order.delivery_handoff_generation}:${disposition}`,
        templateVersion: 'pharmacy.delivery_return_completed.v1',
      }, { tx, strict: true });
      if (!patientNotice?.id) {
        throw AppError.serviceUnavailable(
          'The patient return-completion notice could not be durably queued',
          'PHARMACY_DELIVERY_RETURN_NOTICE_REQUIRED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET status='UNAVAILABLE',
                delivery_custody_status=$4,
                delivery_tracking_active=FALSE,
                cancellation_reason=$5,
                partial_reason=$5,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
            AND status='DISPATCHED' AND delivery_custody_status='return_pending'
            AND delivery_handoff_consumed_at IS NULL
          RETURNING *`,
        req.tenantId,
        orderId,
        facility.id,
        disposition,
        reason,
      );
      if (!updated[0]) return null;
      const packageEvidence = pharmacyDeliveryPackageEvidence(updated[0]);
      await appendPharmacyDeliveryCustodyEventTx(tx, {
        tenantId: req.tenantId,
        orderId,
        facilityId: facility.id,
        eventType: disposition === 'quarantined' ? 'QUARANTINED' : 'RETURNED',
        actorUid,
        actorRole,
        commandKeySha256: command.commandKeySha256,
        requestSha256: command.requestSha256,
        orderAuthorityVersion: updated[0].inventory_authority_version,
        orderItemsSha256: clinicalOrderItemsSha256(updated[0].items_list),
        handoffGeneration: updated[0].delivery_handoff_generation,
        handoffTokenSha256: updated[0].delivery_handoff_token_sha256,
        notificationOutboxIds: [patientNotice.id],
        inventoryEvidence: packageEvidence.inventoryEvidence,
        fundingEvidence: packageEvidence.fundingEvidence,
        custodyEvidence: {
          contract: 'pharmacy_delivery_custody_v1',
          from_custody_status: 'return_pending',
          to_custody_status: disposition,
          package_stock_disposition: 'issued_not_restocked',
          replacement_requires_new_order_authority: true,
        },
        reason,
      });
      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
           (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2::int, 'DISPATCHED', 'UNAVAILABLE', $3, $4, $5)`,
        req.tenantId,
        orderId,
        facilityActor.actor_id,
        facilityActor.actor_role.toLowerCase(),
        `Returned package ${disposition}: ${reason}`,
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.delivery_return_completed', updated[0], {
        from_status: 'DISPATCHED',
        to_status: 'UNAVAILABLE',
        from_custody_status: 'return_pending',
        to_custody_status: disposition,
        package_stock_disposition: 'issued_not_restocked',
        reason,
        performer: facilityActor,
      });
      const payload = await storeOrderCommandReceiptTx(
        tx,
        req,
        orderId,
        command,
        {
          id: updated[0].id,
          status: updated[0].status,
          delivery_custody_status: updated[0].delivery_custody_status,
          delivery_handoff_generation: updated[0].delivery_handoff_generation,
          patient_notice_outbox_id: patientNotice.id,
          package_stock_disposition: 'issued_not_restocked',
        },
        'Delivery return completed',
      );
      return { replay: false, payload };
    });
    if (!result) {
      throw AppError.conflict(
        'Only a return-pending package may be received or quarantined',
        'PHARMACY_DELIVERY_RETURN_COMPLETION_WRONG_STATE',
      );
    }
    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_DELIVERY_RETURN_COMPLETED', result.payload, {
      disposition,
      reason,
    });
    return success(res, result.payload, 'Delivery return completed');
  } catch (err) {
    return relayAppError(res, err, 'Failed to complete delivery return');
  }
};

// Payment modes accepted on the counter dispense payload. Anything else
// is dropped so we don't write garbage strings into the column.
const COUNTER_PAYMENT_MODES = new Set([
  'cash', 'card', 'upi', 'wallet',
  'corporate_tpa', 'insurance', 'none',
]);

const RECEIPT_DELIVERY_MODES = new Set(['phone', 'print', 'email', 'none']);

async function stageCounterFundingAuthority({
  req,
  orderId,
  facilityId,
  paymentMode,
  dispensedItems,
  rawPartialDispense,
  partialReason,
  quantityMismatchAcknowledged,
  insurer,
  policyNumber,
  tpaReference,
}) {
  if (!paymentMode) {
    throw AppError.badRequest(
      'A supported payment mode is required before counter funding can be materialized',
      'PHARMACY_COUNTER_PAYMENT_MODE_REQUIRED',
    );
  }
  return setTenantTx(req.tenantId, async (tx) => {
    await lockTenantPatientMergeStability(tx, req.tenantId);
    await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
    await assertPharmacyFacilityGrant(tx, {
      tenantId: req.tenantId,
      facilityId,
      ...pharmacyFacilityActorFromRequest(req),
      forUpdate: true,
    });
    const verification = await assertVerificationClearedTx(tx, {
      orderId,
      tenantId: req.tenantId,
    });
    if (verification.delivery_type !== 'counter') {
      throw AppError.conflict(
        'Only counter orders can use the counter dispense workflow',
        'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
      );
    }
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT id,status,delivery_type,items_list,patient_id,total_amount,facility_id,
              payment_mode,payment_metadata,inventory_authority_version
         FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
        FOR UPDATE`,
      req.tenantId,
      orderId,
      facilityId,
    );
    if (!orderRows.length) throw AppError.notFound('Order not found');
    const order = orderRows[0];
    if (order.delivery_type !== 'counter') {
      throw AppError.conflict(
        'Counter funding cannot be staged for a delivery order',
        'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
      );
    }
    if (order.status === 'PARTIALLY_DISPENSED') {
      throw AppError.conflict(
        'A partially dispensed order requires a governed remainder split before more stock or funding can move',
        'PHARMACY_PARTIAL_DISPENSE_FUNDING_SPLIT_REQUIRED',
      );
    }
    if (!['PENDING', 'CONFIRMED'].includes(order.status)) {
      throw AppError.conflict(
        `Cannot stage counter funding from status ${order.status}`,
        'PHARMACY_ORDER_COUNTER_WRONG_STATUS',
      );
    }
    const { items: mergedItems, partialFromQty, mismatches } = mergeDispensedItems(
      Array.isArray(order.items_list) ? order.items_list : [],
      Array.isArray(dispensedItems) ? dispensedItems : [],
    );
    if (mismatches.length) {
      const partialIntent = Boolean(rawPartialDispense) || Boolean(partialReason);
      const allUnderDispense = mismatches.every((mismatch) => mismatch.kind === 'under_dispense');
      if (quantityMismatchAcknowledged !== true && !(partialIntent && allUnderDispense)) {
        throw AppError.badRequest(
          'Dispensed quantity does not match the prescribed or ordered quantity',
          'DISPENSE_QUANTITY_MISMATCH',
          { mismatches },
        );
      }
    }
    if (Boolean(rawPartialDispense) || Boolean(partialReason) || partialFromQty) {
      throw AppError.conflict(
        'Partial counter dispense is blocked until the remainder has a separate governed order, funding, and cap authority',
        'PHARMACY_PARTIAL_DISPENSE_FUNDING_SPLIT_REQUIRED',
      );
    }
    const authoritativeLines = await resolveCounterDispenseAuthorityTx(tx, {
      tenantId: req.tenantId,
      facilityId,
      lines: mergedItems,
      completeRemainder: true,
    });
    const authoritativeTotal = Number(authoritativeLines
      .reduce((sum, item) => sum + Number(item.line_total), 0)
      .toFixed(2));
    const existingMode = String(
      order.payment_mode || order.payment_metadata?.payment_mode || '',
    ).trim().toLowerCase();
    if (existingMode && existingMode !== paymentMode) {
      throw AppError.conflict(
        'The order is already locked to a different payment mode',
        'PHARMACY_COUNTER_PAYMENT_AUTHORITY_MISMATCH',
      );
    }
    const suppliedTpaReference = String(tpaReference || '').trim() || null;
    const existingTpaReference = String(order.payment_metadata?.tpa_reference || '').trim() || null;
    if (existingTpaReference && suppliedTpaReference
        && existingTpaReference !== suppliedTpaReference) {
      throw AppError.conflict(
        'The order is already locked to a different TPA reference',
        'PHARMACY_COUNTER_TPA_REFERENCE_MISMATCH',
      );
    }
    const lockedTpaReference = existingTpaReference || suppliedTpaReference;
    if (['insurance', 'corporate_tpa'].includes(paymentMode) && !lockedTpaReference) {
      throw AppError.conflict(
        'Insurance and corporate TPA funding require one durable TPA reference',
        'PHARMACY_COUNTER_TPA_REFERENCE_REQUIRED',
      );
    }
    const paymentMetadata = {
      ...(order.payment_metadata || {}),
      payment_mode: paymentMode,
    };
    if (insurer) paymentMetadata.insurer = String(insurer);
    if (policyNumber) paymentMetadata.policy_number = String(policyNumber);
    if (lockedTpaReference) paymentMetadata.tpa_reference = lockedTpaReference;
    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_orders
          SET items_list=$4::jsonb,total_amount=$5::numeric,payment_mode=$6,
              payment_metadata=$7::jsonb,updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
          AND status=$8 AND inventory_authority_version=$9::int
        RETURNING id,patient_id,facility_id,total_amount,items_list,payment_mode,
                  payment_metadata,inventory_authority_version,status`,
      req.tenantId,
      orderId,
      facilityId,
      JSON.stringify(authoritativeLines),
      authoritativeTotal,
      paymentMode,
      JSON.stringify(paymentMetadata),
      order.status,
      Number(order.inventory_authority_version),
    );
    if (updatedRows.length !== 1) {
      throw AppError.conflict(
        'The order changed while its counter funding tuple was staged',
        'PHARMACY_COUNTER_FUNDING_STAGING_STALE',
      );
    }
    return {
      ...updatedRows[0],
      itemsSha256: clinicalOrderItemsSha256(updatedRows[0].items_list),
    };
  });
}

/**
 * Merge the pharmacist-supplied dispensed_items into the order's
 * existing items_list. Every mutation requires the stable order_line_index;
 * catalog names and list position are never accepted as clinical identity.
 */
export function mergeDispensedItems(existingItems, dispensedItems) {
  const existing = Array.isArray(existingItems) ? existingItems.map((i) => ({ ...i })) : [];
  const dispensed = Array.isArray(dispensedItems) ? dispensedItems : [];
  if (!dispensed.length) {
    return { items: existing, partialFromQty: false, mismatches: [] };
  }
  let partialFromQty = false;
  const selectedLineIndexes = new Set();
  // Lines where the dispensed quantity diverges from the prescribed/ordered
  // quantity, or where the order itself never carried a confirmed quantity
  // (quantity_needs_confirmation). The dispense flow must surface these and
  // require acknowledgement rather than silently billing/fulfilling whatever
  // the pharmacist typed. Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24.
  const mismatches = [];
  for (const d of dispensed) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw AppError.badRequest(
        'Every dispensed item must be an object linked to an authoritative order line',
        'PHARMACY_ORDER_DISPENSE_LINE_INVALID',
      );
    }
    if (Object.hasOwn(d, 'price') || Object.hasOwn(d, 'line_total')) {
      throw AppError.badRequest(
        'Dispense line pricing is server-authoritative',
        'PHARMACY_ORDER_PRICE_MUTATION_FORBIDDEN',
      );
    }
    const dCatalogId = d.catalog_id ? Number(d.catalog_id) : null;
    const dName = d.name || d.medication_name || d.drug_name || null;
    const rawLineIndex = d.order_line_index;
    const requestedLineIndex = Number(rawLineIndex);
    const hasLineIndex = Number.isSafeInteger(requestedLineIndex)
      && requestedLineIndex >= 0;
    if (!hasLineIndex) {
      throw AppError.badRequest(
        'order_line_index must identify an authoritative order line',
        'PHARMACY_ORDER_DISPENSE_LINE_INVALID',
      );
    }
    const authoritativeLine = existing[requestedLineIndex];
    const matches = authoritativeLine
      && dCatalogId
      && Number(authoritativeLine.catalog_id) === dCatalogId
      ? [{ line: authoritativeLine, lineIndex: requestedLineIndex }]
      : [];
    if (matches.length === 0) {
      throw AppError.conflict(
        'Dispensed item does not match an authoritative order line',
        'PHARMACY_ORDER_DISPENSE_LINE_UNRESOLVED',
        { catalog_id: dCatalogId, name: dName },
      );
    }
    if (matches.length > 1) {
      throw AppError.conflict(
        'Dispensed item matches multiple order lines; order_line_index is required',
        'PHARMACY_ORDER_DISPENSE_LINE_AMBIGUOUS',
        {
          catalog_id: dCatalogId,
          name: dName,
          candidate_order_line_indexes: matches.map(({ lineIndex }) => lineIndex),
        },
      );
    }
    const idx = matches[0].lineIndex;
    if (selectedLineIndexes.has(idx)) {
      throw AppError.badRequest(
        'An authoritative order line may be dispensed only once per request',
        'PHARMACY_ORDER_DISPENSE_LINE_DUPLICATE',
      );
    }
    selectedLineIndexes.add(idx);
    const orderedQty = Number(
      existing[idx].ordered_qty
        ?? existing[idx].prescribed_qty
        ?? existing[idx].quantity
        ?? existing[idx].qty
        ?? 0,
    );
    const dispensedQty = Number(d.dispensed_quantity ?? d.dispensed_qty ?? d.qty ?? d.quantity ?? orderedQty);
    const effectiveQty = Number.isFinite(dispensedQty) && dispensedQty >= 0 ? dispensedQty : orderedQty;
    if (orderedQty > 0 && effectiveQty < orderedQty) partialFromQty = true;
    // Mismatch: dispensed differs from a positive ordered quantity, OR the
    // order line never had a confirmed quantity but a quantity is being
    // dispensed. Under-dispense alone (partial) is allowed once acknowledged.
    const lineNeedsConfirmation = idx >= 0
      && Boolean(existing[idx].quantity_needs_confirmation);
    if (orderedQty > 0 && effectiveQty !== orderedQty) {
      mismatches.push({
        catalog_id: dCatalogId ?? (idx >= 0 ? existing[idx].catalog_id ?? null : null),
        name: dName ?? (idx >= 0 ? existing[idx].name ?? existing[idx].medication_name ?? null : null),
        ordered_qty: orderedQty,
        dispensed_qty: effectiveQty,
        kind: effectiveQty > orderedQty ? 'over_dispense' : 'under_dispense',
      });
    } else if (lineNeedsConfirmation && effectiveQty > 0) {
      mismatches.push({
        catalog_id: dCatalogId ?? existing[idx].catalog_id ?? null,
        name: dName ?? existing[idx].name ?? existing[idx].medication_name ?? null,
        ordered_qty: orderedQty,
        dispensed_qty: effectiveQty,
        kind: 'unconfirmed_order_qty',
      });
    }
    const merged = { ...existing[idx] };
    merged.order_line_index = idx;
    merged.qty = effectiveQty;
    if (orderedQty > 0) merged.ordered_qty = orderedQty;
    merged.dispensed_qty = effectiveQty;
    // The pharmacist has now acted on this line, so the "quantity unconfirmed"
    // flag from order creation is resolved — drop it so the dispensed record
    // doesn't carry a stale needs-confirmation marker.
    if ('quantity_needs_confirmation' in merged) delete merged.quantity_needs_confirmation;
    if (d.dispensed_quantity_ml != null) merged.dispensed_quantity_ml = Number(d.dispensed_quantity_ml);
    if (d.prescribed_dose) merged.prescribed_dose = d.prescribed_dose;
    if (d.child_weight_kg != null) merged.child_weight_kg = Number(d.child_weight_kg);
    if (d.measuring_instruction) merged.measuring_instruction = d.measuring_instruction;
    if (d.label_instruction) merged.label_instruction = d.label_instruction;
    if (d.instructions) merged.instructions = d.instructions;
    if (d.batch_no) merged.batch_no = d.batch_no;
    if (d.expiry_date) merged.expiry_date = d.expiry_date;
    if (d.inventory_item_id != null) {
      const requestedInventoryItemId = Number(d.inventory_item_id);
      const historicalInventoryItemId = Number(existing[idx].inventory_item_id);
      if (Number(existing[idx].inventory_dispensed_quantity || 0) > 0
        && (!Number.isSafeInteger(historicalInventoryItemId) || historicalInventoryItemId <= 0
          || requestedInventoryItemId !== historicalInventoryItemId)) {
        throw AppError.conflict(
          'Previously dispensed medication lines cannot replace their Inventory V2 identity',
          'PHARMACY_ORDER_INVENTORY_EVIDENCE_CONFLICT',
          { order_line_index: idx },
        );
      }
      merged.inventory_item_id = requestedInventoryItemId;
    }
    if (Array.isArray(d.inventory_allocations)) {
      if (!d.inventory_allocations.length) {
        throw AppError.badRequest(
          'inventory_allocations must contain exact batch evidence when supplied',
          'PHARMACY_ORDER_BATCH_ALLOCATION_INVALID',
        );
      }
      merged.inventory_allocations = d.inventory_allocations.map((allocation) => ({
        ...allocation,
      }));
    }
    existing[idx] = merged;
  }
  for (let index = 0; index < existing.length; index += 1) {
    if (selectedLineIndexes.has(index)) continue;
    const alreadyDispensed = Math.max(
      0,
      Number(existing[index].inventory_dispensed_quantity || 0),
    );
    existing[index].dispensed_qty = alreadyDispensed;
  }
  return { items: existing, partialFromQty, mismatches };
}

/**
 * B-2 — counter-dispense flow. The patient walks up to the pharmacy
 * with their Rx, the pharmacist confirms + hands it over on the spot.
 * No CONFIRMED -> PREPARING -> DISPATCHED -> DELIVERED chain — that's
 * for delivery orders. From PENDING (or CONFIRMED) directly to
 * DISPENSED, with the same stock-decrement + Rx-fulfilment hooks
 * markDelivered runs. Required: delivery_type='counter' on the order
 * (else use the delivery flow).
 *
 * The pharmacist may supply a rich dispense payload — partial quantity,
 * paediatric label, cash/TPA payment, guardian acknowledgement, receipt
 * delivery preference. All of it is persisted on the order so the label
 * endpoint + billing can reach it. See findings
 *   2026-05-09-pediatric-opd-pharmacy-zero-bill-no-items
 *   2026-05-10-pediatric-opd-pharmacy-dispense-payload-label-payment-dropped
 *   2026-05-10-walk-in-opd-pharmacy-partial-dispense-payment-ignored
 */
export const markCounterDispensed = async (req, res) => {
  try {
    const orderId = pharmacyOrderIdOrNull(req.params.id);
    if (!orderId) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const commandKeySha256 = dispenseCommandKey(req, `counter:${orderId}`);
    const command = {
      action: 'counter',
      commandKeySha256,
      requestSha256: pharmacyCommandRequestSha256(counterDispenseCommandPayload(req)),
    };
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res,
      commandReplay.payload,
      commandReplay.message || (commandReplay.payload?.status === 'PARTIALLY_DISPENSED'
        ? 'Counter partial dispense recorded; remainder remains open'
        : 'Counter dispense complete'),
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });

    // B1 — pharmacist clinical verification gates counter dispense (the
    // walk-in short-circuit skips PREPARING, so the gate must sit here).
    const {
      dispensed_items,
      payment_mode: rawPaymentMode,
      payment_method,
      amount_collected,
      partial_dispense: rawPartialDispense,
      partial_reason,
      confirmation_notes,
      receipt_delivery,
      guardian_acknowledged,
      quantity_mismatch_acknowledged,
      mismatch_reason,
      insurer,
      policy_number,
      tpa_reference,
      cap_override,
      cap_override_reason,
    } = req.body ?? {};
    const capOverride = pharmacyCapOverrideAuthority(req, cap_override, cap_override_reason);

    const paymentModeInput = String(rawPaymentMode ?? payment_method ?? '').toLowerCase();
    const paymentMode = COUNTER_PAYMENT_MODES.has(paymentModeInput) ? paymentModeInput : null;
    const amountCollected = (() => {
      const n = Number(amount_collected);
      return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
    })();
    const receiptDelivery = RECEIPT_DELIVERY_MODES.has(String(receipt_delivery ?? '').toLowerCase())
      ? String(receipt_delivery).toLowerCase()
      : null;

    const stagedFundingOrder = await stageCounterFundingAuthority({
      req,
      orderId,
      facilityId: facility.id,
      paymentMode,
      dispensedItems: dispensed_items,
      rawPartialDispense,
      partialReason: partial_reason,
      quantityMismatchAcknowledged: quantity_mismatch_acknowledged,
      insurer,
      policyNumber: policy_number,
      tpaReference: tpa_reference,
    });
    const fundingPreparation = await materializePharmacyFundingAuthority({
      tenantId: req.tenantId,
      orderId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
    });
    if (fundingPreparation?.status !== 'funded') {
      throw AppError.conflict(
        'Posted payment or exact TPA funding must be completed before counter stock moves',
        'PHARMACY_COUNTER_FUNDING_REQUIRED',
        {
          next_action: fundingPreparation?.fundingRecovery
            ? 'open_exact_pharmacy_funding_task'
            : 'materialize_pharmacy_funding',
          materialize_path: `/api/v1/billing/v2/pharmacy-funding/orders/${orderId}/materialize`,
          funding_recovery: fundingPreparation?.fundingRecovery || null,
        },
      );
    }

    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      await assertPharmacyFacilityGrant(tx, {
        tenantId: req.tenantId,
        facilityId: facility.id,
        ...pharmacyFacilityActorFromRequest(req),
        forUpdate: true,
      });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, ok: replay.payload };
      const verification = await assertVerificationClearedTx(tx, {
        orderId,
        tenantId: req.tenantId,
      });
      if (verification.delivery_type !== 'counter') {
        throw AppError.conflict(
          'Only counter orders can use the counter dispense workflow',
          'PHARMACY_ORDER_WRONG_DELIVERY_FLOW',
        );
      }
      // Pull state + delivery_type up-front so the wrong-flow guard
      // returns a clean 400 instead of an empty UPDATE result.
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, status, delivery_type, items_list, patient_id,
                patient_name, patient_phone, order_number, total_amount, facility_id,
                inventory_authority_version,payment_mode,payment_metadata
           FROM pharmacy_orders
          WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int
          FOR UPDATE`,
        orderId, req.tenantId, facility.id,
      );
      if (!existing.length) return { error: 'NOT_FOUND' };
      const order = existing[0];
      if (order.delivery_type !== 'counter') {
        return { error: 'WRONG_FLOW' };
      }
      if (!['PENDING', 'CONFIRMED'].includes(order.status)) {
        return { error: 'WRONG_STATUS', status: order.status };
      }
      // Merge pharmacist-supplied dispensed_items into the items_list
      // already on the order (typically populated by orderPharmacyFromPrescription
      // or the confirm step). When the pharmacist passes a partial qty
      // the merged line carries dispensed_qty AND ordered_qty so the
      // remaining-balance is reachable from the order detail.
      const { items: mergedItems, partialFromQty, mismatches } = mergeDispensedItems(
        Array.isArray(order.items_list) ? order.items_list : [],
        Array.isArray(dispensed_items) ? dispensed_items : [],
      );

      // Quantity-safety gate. A dispensed quantity that differs from the
      // prescribed/ordered quantity — or any line whose order quantity was
      // never confirmed (defaulted to 1 at order creation) — must NOT be
      // billed and fulfilled silently. Require an explicit acknowledgement:
      //   - quantity_mismatch_acknowledged=true (any mismatch), or
      //   - partial_dispense / partial_reason (under-dispense only — the
      //     existing partial-dispense intent already covers giving less).
      // Otherwise block with a clear 400 so the counter UI prompts the
      // pharmacist to confirm the true count.
      // Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24 (+ 938226ba).
      if (mismatches.length) {
        const acknowledged = quantity_mismatch_acknowledged === true;
        const partialIntent = Boolean(rawPartialDispense) || Boolean(partial_reason);
        const allUnderDispense = mismatches.every((m) => m.kind === 'under_dispense');
        if (!acknowledged && !(partialIntent && allUnderDispense)) {
          return { error: 'QUANTITY_MISMATCH', mismatches };
        }
      }

      const authoritativeLines = await resolveCounterDispenseAuthorityTx(tx, {
        tenantId: req.tenantId,
        facilityId: order.facility_id,
        lines: mergedItems,
        completeRemainder: !Array.isArray(dispensed_items) || dispensed_items.length === 0,
      });
      const totalAmount = Number(authoritativeLines
        .reduce((sum, item) => sum + Number(item.line_total), 0)
        .toFixed(2));
      let partialDispense = Boolean(rawPartialDispense) || partialFromQty;

      const currentItemsSha256 = clinicalOrderItemsSha256(order.items_list);
      if (partialDispense
          || Number(order.inventory_authority_version)
            !== Number(stagedFundingOrder.inventory_authority_version)
          || currentItemsSha256 !== stagedFundingOrder.itemsSha256
          || Math.abs(totalAmount - Number(stagedFundingOrder.total_amount || 0)) > 0.001
          || String(order.payment_mode || '').trim().toLowerCase() !== paymentMode) {
        throw AppError.conflict(
          partialDispense
            ? 'Partial counter dispense requires a governed remainder funding split'
            : 'The staged counter funding tuple changed before stock allocation',
          partialDispense
            ? 'PHARMACY_PARTIAL_DISPENSE_FUNDING_SPLIT_REQUIRED'
            : 'PHARMACY_COUNTER_FUNDING_STAGING_STALE',
        );
      }

      const funding = await resolveAuthoritativeCounterFundingTx(tx, {
        tenantId: req.tenantId,
        patientId: order.patient_id,
        orderId,
        paymentMode,
        totalAmount,
        orderVersion: Number(order.inventory_authority_version),
        orderItemsSha256: currentItemsSha256,
      });
      if (amountCollected != null
          && Math.abs(amountCollected - Number(funding.collectedAmount || 0)) > 0.001) {
        throw AppError.conflict(
          'The submitted collected amount does not match the durable posted-payment allocation',
          'PHARMACY_COUNTER_COLLECTED_AMOUNT_AUTHORITY_MISMATCH',
          { authoritative_collected_amount: Number(funding.collectedAmount || 0) },
        );
      }
      const capProbe = await assertPharmacyCapForDispenseTx(tx, {
        tenantId: req.tenantId,
        patientId: order.patient_id,
        additionalAmount: totalAmount,
        allowOverride: capOverride != null,
        orderId,
        facilityId: order.facility_id,
        actorUid: req.user?.uid || null,
        actorRole: req.user?.role || null,
        commandKeySha256,
        fundingSource: funding.fundingSource,
        fundingReference: funding.fundingReference,
        fundingTpaClaimId: funding.fundingTpaClaimId,
        authorisedFundingAmount: funding.fundedAmount,
      });
      if (capProbe.message) {
        logger.warn('Pharmacy cap probe', { order_id: orderId, ...capProbe });
      }

      const paymentMetadata = { ...(order.payment_metadata || {}) };
      if (insurer) paymentMetadata.insurer = String(insurer);
      if (policy_number) paymentMetadata.policy_number = String(policy_number);
      if (tpa_reference) paymentMetadata.tpa_reference = String(tpa_reference);
      if (funding.fundedAmount > 0) {
        paymentMetadata.funding_source = funding.fundingSource;
        paymentMetadata.funding_reference = funding.fundingReference;
        paymentMetadata.approval_reference = funding.approvalReference || null;
        paymentMetadata.authorised_funded_amount = funding.fundedAmount;
      }
      if (typeof guardian_acknowledged === 'boolean') {
        paymentMetadata.guardian_acknowledged = guardian_acknowledged;
      }
      const hasPaymentMetadata = Object.keys(paymentMetadata).length > 0;

      const paymentStatus = 'paid';

      const inventory = await allocateOrderInventoryTx(tx, {
        tenantId: req.tenantId,
        order,
        lines: authoritativeLines,
        actorUid: req.user?.uid || null,
        actorRole: req.user?.role || req.user?.rawRole || null,
        commandKeySha256,
        operation: 'counter',
        completeRemainder: !Array.isArray(dispensed_items) || dispensed_items.length === 0,
      });
      const inventoryItems = inventory.lines;
      partialDispense = inventoryItems.some((line) => (
        Number(line.inventory_remaining_quantity || line.remaining_qty || 0) > 0.000001
      ));
      if (partialDispense) {
        throw AppError.conflict(
          'Available stock cannot fulfill the governed full-order funding authority; no stock was committed',
          'PHARMACY_PARTIAL_DISPENSE_FUNDING_SPLIT_REQUIRED',
        );
      }
      const nextStatus = partialDispense ? 'PARTIALLY_DISPENSED' : 'DISPENSED';

      // Build the dispense_label snapshot. Pharmacy app / staff app can
      // re-render this without re-reading the prescription. Keep the
      // shape tight — patient name, items with labels, dispensed_at.
      const dispenseLabel = {
        order_number: order.order_number,
        patient_name: order.patient_name,
        dispensed_at: new Date().toISOString(),
        partial_dispense: partialDispense,
        partial_reason: partial_reason ?? null,
        items: inventoryItems.map((i) => ({
          name: i.name || i.medication_name || null,
          strength: i.strength ?? null,
          dose: i.dose ?? i.prescribed_dose ?? null,
          frequency: i.frequency ?? null,
          duration: i.duration ?? null,
          route: i.route ?? null,
          dispensed_qty: i.dispensed_qty ?? i.qty,
          dispensed_quantity_ml: i.dispensed_quantity_ml ?? null,
          child_weight_kg: i.child_weight_kg ?? null,
          measuring_instruction: i.measuring_instruction ?? null,
          label_instruction: i.label_instruction ?? i.instructions ?? null,
          inventory_item_id: i.inventory_item_id ?? null,
          inventory_allocation_evidence: i.inventory_allocation_evidence ?? [],
        })),
        inventory_allocations: inventory.allocations,
      };

      // dispensed_by is UUID FK → users.uid (not the int id). Use the
      // JWT's uid claim, not the integer id used elsewhere in this
      // controller for confirmed_by/changed_by (those are int FKs).
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET status=$15,
                dispensed_by=$2::uuid,
                dispensed_at=NOW(),
                delivery_tracking_active=FALSE,
                items_list=$3::jsonb,
                dispensed_medications=$3::jsonb,
                total_amount=$4,
                payment_status=$5,
                payment_mode=$6,
                amount_collected=$7,
                partial_dispense=$8,
                partial_reason=$9,
                receipt_delivery=$10,
                payment_metadata=$11::jsonb,
                dispense_label=$12::jsonb,
                confirmation_notes=COALESCE($13, confirmation_notes),
                updated_at=NOW()
          WHERE id=$1 AND tenant_id=$14::uuid AND facility_id=$16::int
          RETURNING id, uid, tenant_id, patient_id, patient_name, status, order_note,
                    total_amount, items_list, dispensed_medications,
                    payment_status, payment_mode, amount_collected,
                    partial_dispense, partial_reason, receipt_delivery,
                    payment_metadata, dispense_label, confirmation_notes,
                    dispensed_at, created_at, updated_at, order_number, delivery_type`,
        orderId,
        req.user?.uid ?? null,
        JSON.stringify(inventoryItems),
        totalAmount,
        paymentStatus,
        paymentMode,
        Number(funding.collectedAmount || 0),
        partialDispense,
        partial_reason ?? null,
        receiptDelivery,
        hasPaymentMetadata ? JSON.stringify(paymentMetadata) : null,
        JSON.stringify(dispenseLabel),
        confirmation_notes ?? null,
        req.tenantId,
        nextStatus,
        order.facility_id,
      );
      const out = updated[0];

      if (inventory.prescription) {
        await applyOrderPrescriptionProjectionTx(tx, {
          tenantId: req.tenantId,
          prescription: inventory.prescription,
        });
      }

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2, $3, $4, $5, 'pharmacist', $6)`,
        req.tenantId,
        orderId,
        order.status,
        nextStatus,
        req.user?.id ?? null,
        (() => {
          let note = partialDispense
            ? `Counter dispense (partial${partial_reason ? `: ${partial_reason}` : ''})`
            : 'Counter dispense';
          if (mismatches.length && quantity_mismatch_acknowledged === true) {
            note += ` — quantity mismatch acknowledged${mismatch_reason ? `: ${String(mismatch_reason)}` : ''}`;
          }
          if (capOverride) {
            note += ` — ${capOverrideHistoryNote(capOverride)}`;
          }
          return note;
        })(),
      );
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_dispensed', out, {
        from_status: order.status,
        to_status: nextStatus,
        partial_dispense: Boolean(out.partial_dispense),
        payment_status: out.payment_status || null,
        inventory_allocations: inventory.allocations,
        tpa_cap_override: capOverride,
      });
      const barcodeRows = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET pack_barcode=COALESCE(pack_barcode, $3), updated_at=NOW()
          WHERE id=$1::int AND tenant_id=$2::uuid
          RETURNING pack_barcode`,
        orderId,
        req.tenantId,
        `VHMP-${orderId}-${commandKeySha256.slice(0, 8).toUpperCase()}`,
      );
      out.pack_barcode = barcodeRows[0]?.pack_barcode || null;
      const message = out.status === 'PARTIALLY_DISPENSED'
        ? 'Counter partial dispense recorded; remainder remains open'
        : 'Counter dispense complete';
      await storeOrderCommandReceiptTx(tx, req, orderId, command, out, message);
      return { replay: false, ok: out };
    });

    if (result.error === 'NOT_FOUND') return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    if (result.error === 'WRONG_FLOW') {
      return error(res, 'Order is not a counter order — use the delivery flow', HTTP_STATUS.BAD_REQUEST);
    }
    if (result.error === 'WRONG_STATUS') {
      return error(res, `Cannot dispense from status=${result.status}; expected PENDING or CONFIRMED`, HTTP_STATUS.BAD_REQUEST);
    }
    if (result.error === 'QUANTITY_MISMATCH') {
      return error(
        res,
        'Dispensed quantity does not match the prescribed/ordered quantity. Confirm the correct count and resubmit with quantity_mismatch_acknowledged=true (and an optional mismatch_reason), or mark a partial dispense for an under-supply.',
        HTTP_STATUS.BAD_REQUEST,
        { code: 'DISPENSE_QUANTITY_MISMATCH', mismatches: result.mismatches },
      );
    }
    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_DISPENSED', result.ok, {
      to_status: result.ok?.status || null,
      partial_dispense: Boolean(result.ok?.partial_dispense),
      payment_status: result.ok?.payment_status || null,
      tpa_cap_override: capOverride,
    });
    success(
      res,
      result.ok,
      result.ok?.status === 'PARTIALLY_DISPENSED'
        ? 'Counter partial dispense recorded; remainder remains open'
        : 'Counter dispense complete',
    );
  } catch (err) {
    logger.error('Counter dispense error:', err);
    return relayAppError(res, err, 'Failed to dispense order');
  }
};

export const markUnavailable = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const orderId = pharmacyOrderIdOrNull(req.params.id);
    if (!orderId) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const command = pharmacyOrderCommand(req, orderId, 'unavailable');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Order marked unavailable',
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });

    const { reason, unavailable_items } = req.body ?? {};
    const unavailableReason = String(reason || '').trim();
    if (unavailableReason.length < 3 || unavailableReason.length > 500) {
      throw AppError.badRequest(
        'reason must be between 3 and 500 characters',
        'PHARMACY_ORDER_UNAVAILABLE_REASON_REQUIRED',
      );
    }
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      await resolveOrderPharmacyFacility(tx, {
        tenantId,
        ...pharmacyFacilityActorFromRequest(req),
        orderId,
        requestedFacilityId: facility.id,
        forUpdate: true,
      });
      const order = await tx.$queryRawUnsafe(
        `SELECT id, uid, patient_id, patient_name, status, order_number, facility_id, items_list,
                delivery_type, delivery_custody_status, delivery_custody_contract_version
           FROM pharmacy_orders
          WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int
          FOR UPDATE`,
        orderId,
        tenantId,
        facility.id,
      );
      if (!order.length) return { error: 'NOT_FOUND' };
      if (['DISPENSED', 'DELIVERED', 'CANCELLED', 'UNAVAILABLE'].includes(order[0].status)) {
        return { error: 'CLOSED' };
      }
      const fromStatus = order[0].status;
      // A delivery package that already left the counter is in courier custody.
      // Closing it as unavailable from here would record a terminal state with
      // no disposition for the issued stock, so the database refuses it
      // (chk_pharmacy_orders_delivery_handoff_lifecycle_753). Fail with the
      // typed conflict that names the correct path instead of letting the
      // constraint surface as an opaque 500. Pre-dispatch delivery orders and
      // counter orders hold no custody and are unaffected.
      if (order[0].delivery_type === 'delivery' && (
        fromStatus === 'DISPATCHED'
        || Boolean(order[0].delivery_custody_status)
        || Boolean(order[0].delivery_custody_contract_version)
      )) {
        // Both arms fail closed; they differ only in the path they name. A row
        // carrying the v1 custody contract can be closed through the governed
        // return flow. A legacy row dispatched before migration 753 carries no
        // contract and no custody status, so requestDeliveryReturn — which
        // matches on delivery_custody_status='in_transit' — can never select
        // it; its only resolution is the ORDER_DELIVERY_CUSTODY_UNRESOLVED
        // worklist that migration 753 opened for exactly these rows. Naming the
        // return flow there would send the operator down a dead end.
        if (Number(order[0].delivery_custody_contract_version) === 1) {
          throw AppError.conflict(
            'A dispatched delivery package is in courier custody and must be closed through the delivery return flow, not marked unavailable',
            'PHARMACY_DELIVERY_CUSTODY_RETURN_REQUIRED',
          );
        }
        throw AppError.conflict(
          'This delivery was dispatched without a recorded custody contract and cannot be marked unavailable until its ORDER_DELIVERY_CUSTODY_UNRESOLVED recovery worklist entry is resolved',
          'PHARMACY_DELIVERY_CUSTODY_UNRESOLVED',
        );
      }
      const hasDispensedInventory = (Array.isArray(order[0].items_list)
        ? order[0].items_list : []).some((line) => (
        Number(line?.inventory_dispensed_quantity || 0) > 0.000001
      ));
      if (hasDispensedInventory || fromStatus === 'PARTIALLY_DISPENSED') {
        throw AppError.conflict(
          'Unavailable cannot close an order with dispensed stock until a governed remainder or return split is completed',
          'PHARMACY_TERMINAL_PARTIAL_DISPENSE_COMPENSATION_REQUIRED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET status='UNAVAILABLE',
                cancellation_reason=$2,
                partial_reason=$2,
                updated_at=NOW()
          WHERE id=$1 AND tenant_id=$4::uuid AND facility_id=$5::int AND status=$3
          RETURNING id, uid, tenant_id, patient_id, patient_name, status, order_note, total_amount,
                    cancellation_reason, partial_reason, items_list, created_at, updated_at, order_number`,
        orderId,
        unavailableReason,
        fromStatus,
        tenantId,
        facility.id,
      );
      if (!updated.length) return null;

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2, $3, 'UNAVAILABLE', $4, 'pharmacist', $5)`,
        tenantId, orderId, fromStatus, req.user?.id, unavailableReason,
      );
      const prescriptionRecovery = await reopenLinkedPrescriptionRemainderTx(tx, {
        tenantId,
        orderId,
        terminalStatus: 'UNAVAILABLE',
        reason: unavailableReason,
        actorUid: req.user?.uid || null,
      });
      const fundingCompensation = await compensateTerminalPharmacyFundingAuthorityTx(tx, {
        tenantId,
        orderId,
        actorUid: req.user?.uid || null,
        actorRole: req.user?.role || null,
      });
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_unavailable', updated[0], {
        from_status: fromStatus,
        to_status: 'UNAVAILABLE',
        reason: unavailableReason,
        unavailable_items: Array.isArray(unavailable_items) ? unavailable_items : null,
        prescription_reopened_for_remainder: Boolean(prescriptionRecovery),
        funding_compensation: fundingCompensation,
      });
      updated[0].from_status = fromStatus;
      updated[0].funding_compensation = fundingCompensation;
      const payload = await storeOrderCommandReceiptTx(
        tx, req, orderId, command, updated[0], 'Order marked unavailable',
      );
      return { replay: false, payload };
    });

    if (result?.error === 'NOT_FOUND') throw AppError.notFound('Order not found');
    if (result?.error === 'CLOSED') {
      throw AppError.conflict(
        'Order is already closed and cannot be marked unavailable',
        'PHARMACY_ORDER_UNAVAILABLE_CLOSED',
      );
    }
    if (!result?.payload) {
      throw AppError.conflict(
        'Order status changed before it was marked unavailable',
        'PHARMACY_ORDER_UNAVAILABLE_STATE_CHANGED',
      );
    }

    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_UNAVAILABLE', result.payload, {
      from_status: result.payload?.from_status || null,
      to_status: 'UNAVAILABLE',
      reason: unavailableReason,
      unavailable_items: Array.isArray(unavailable_items) ? unavailable_items : null,
    });
    success(res, result.payload, 'Order marked unavailable');
  } catch (err) {
    return relayAppError(res, err, 'Failed to mark order unavailable');
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const { id } = req.params;
    const orderId = requirePharmacyOrderId(id);
    const command = pharmacyOrderCommand(req, orderId, 'cancel');
    const commandReplay = await findOrderCommandReplay(req, orderId, command);
    if (commandReplay) return success(
      res, commandReplay.payload, commandReplay.message || 'Order cancelled',
    );
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const { cancellation_reason } = req.body;
    const cancellationReason = String(cancellation_reason || '').trim();
    if (cancellationReason.length < 3 || cancellationReason.length > 500) {
      throw AppError.badRequest(
        'cancellation_reason must be between 3 and 500 characters',
        'PHARMACY_ORDER_CANCELLATION_REASON_REQUIRED',
      );
    }
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockTenantPatientMergeStability(tx, req.tenantId);
      await lockOrderFundingAuthorityTx(tx, { tenantId: req.tenantId, orderId });
      const replay = await loadOrderCommandReplayTx(tx, req, orderId, command);
      if (replay) return { replay: true, payload: replay.payload };
      await resolveOrderPharmacyFacility(tx, {
        tenantId,
        ...pharmacyFacilityActorFromRequest(req),
        orderId,
        requestedFacilityId: facility.id,
        forUpdate: true,
      });
      const orders = await tx.$queryRawUnsafe(
        `SELECT id, status, items_list FROM pharmacy_orders
          WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int
          FOR UPDATE`,
        parseInt(id), tenantId, facility.id,
      );
      if (!orders.length) return { error: 'NOT_FOUND' };
      if (['DISPENSED', 'DELIVERED', 'CANCELLED', 'UNAVAILABLE'].includes(orders[0].status)) {
        return { error: 'CLOSED' };
      }
      const fromStatus = orders[0].status;
      const hasDispensedInventory = (Array.isArray(orders[0].items_list)
        ? orders[0].items_list : []).some((line) => (
        Number(line?.inventory_dispensed_quantity || 0) > 0.000001
      ));
      if (hasDispensedInventory || fromStatus === 'PARTIALLY_DISPENSED') {
        throw AppError.conflict(
          'Cancellation cannot close an order with dispensed stock until a governed remainder or return split is completed',
          'PHARMACY_TERMINAL_PARTIAL_DISPENSE_COMPENSATION_REQUIRED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders SET status='CANCELLED', cancellation_reason=$2,
           cancelled_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND tenant_id=$4::uuid AND facility_id=$5::int AND status=$3
         RETURNING id, uid, tenant_id, patient_id, patient_name, status, order_note, total_amount,
           cancellation_reason, cancelled_at, created_at, updated_at, order_number`,
        parseInt(id), cancellationReason, fromStatus, tenantId, facility.id
      );
      if (!updated.length) return null;

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history
          (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1::uuid, $2, $3, 'CANCELLED', $4, 'staff', $5)`,
        tenantId, parseInt(id), fromStatus, req.user?.id, cancellationReason
      );
      const prescriptionRecovery = await reopenLinkedPrescriptionRemainderTx(tx, {
        tenantId,
        orderId,
        terminalStatus: 'CANCELLED',
        reason: cancellationReason,
        actorUid: req.user?.uid || null,
      });
      const fundingCompensation = await compensateTerminalPharmacyFundingAuthorityTx(tx, {
        tenantId,
        orderId: parseInt(id),
        actorUid: req.user?.uid || null,
        actorRole: req.user?.role || null,
      });
      await emitPharmacyOrderEventInTx(tx, req, 'pharmacy.order_cancelled', updated[0], {
        from_status: fromStatus,
        to_status: 'CANCELLED',
        reason: cancellationReason,
        prescription_reopened_for_remainder: Boolean(prescriptionRecovery),
        funding_compensation: fundingCompensation,
      });
      updated[0].from_status = fromStatus;
      updated[0].funding_compensation = fundingCompensation;
      const payload = await storeOrderCommandReceiptTx(
        tx, req, orderId, command, updated[0], 'Order cancelled',
      );
      return { replay: false, payload };
    });

    if (result?.error === 'NOT_FOUND') throw AppError.notFound('Order not found');
    if (result?.error === 'CLOSED') {
      throw AppError.conflict('Cannot cancel a closed order', 'PHARMACY_ORDER_CANCEL_CLOSED');
    }
    if (!result?.payload) {
      throw AppError.conflict(
        'Order status changed before cancellation',
        'PHARMACY_ORDER_CANCEL_STATE_CHANGED',
      );
    }

    if (!result.replay) auditPharmacyOrder(req, 'PHARMACY_ORDER_CANCELLED', result.payload, {
      from_status: result.payload?.from_status || null,
      to_status: 'CANCELLED',
      reason: cancellationReason,
    });
    success(res, result.payload, 'Order cancelled');
  } catch (err) {
    return relayAppError(res, err, 'Failed to cancel order');
  }
};

export const getPharmacySLADashboard = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const facility = await resolvePharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const { from_date, to_date } = req.query;
    const from = from_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];

    const [summary, avgTimes, slaBreaches] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int as total,
          COUNT(CASE WHEN status='PENDING' THEN 1 END)::int as placed,
          COUNT(CASE WHEN status='CONFIRMED' THEN 1 END)::int as confirmed,
          COUNT(CASE WHEN status='PREPARING' THEN 1 END)::int as preparing,
          COUNT(CASE WHEN status='DISPATCHED' THEN 1 END)::int as dispatched,
          COUNT(CASE WHEN status='DELIVERED' THEN 1 END)::int as delivered,
          COUNT(CASE WHEN status='DISPENSED' THEN 1 END)::int as dispensed,
          COUNT(CASE WHEN partial_dispense IS TRUE THEN 1 END)::int as partially_dispensed,
          COUNT(CASE WHEN status='UNAVAILABLE' THEN 1 END)::int as unavailable,
          COUNT(CASE WHEN status='CANCELLED' THEN 1 END)::int as cancelled,
          SUM(CASE WHEN status IN ('DELIVERED','DISPENSED') THEN COALESCE(total_amount,0) ELSE 0 END) as total_revenue
        FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND facility_id=$2::int
          AND DATE(created_at) BETWEEN $3::date AND $4::date
      `, tenantId, facility.id, from, to),
      prisma.$queryRawUnsafe(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (confirmed_at-created_at))/60) as avg_confirm_mins,
          AVG(EXTRACT(EPOCH FROM (dispatched_at-confirmed_at))/60) as avg_dispatch_mins,
          AVG(EXTRACT(EPOCH FROM (delivered_at-dispatched_at))/60) as avg_delivery_mins
        FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND facility_id=$2::int
          AND delivered_at IS NOT NULL AND DATE(created_at) BETWEEN $3::date AND $4::date
      `, tenantId, facility.id, from, to),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int as count FROM pharmacy_orders
         WHERE tenant_id=$1::uuid AND facility_id=$2::int
           AND status='PENDING' AND sla_confirm_target IS NOT NULL AND NOW()>sla_confirm_target
           AND DATE(created_at) BETWEEN $3::date AND $4::date`,
        tenantId, facility.id, from, to
      ),
    ]);

    success(res, {
      summary: summary[0],
      avg_times: avgTimes[0],
      sla_breaches: parseInt(slaBreaches[0]?.count || 0),
      date_range: { from, to }
    });
  } catch (err) {
    return relayAppError(res, err, 'Failed to fetch SLA data');
  }
};

export const getOrderDetail = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const orderId = requirePharmacyOrderId(req.params.id);
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const { id } = req.params;
    const order = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, prescription_url,
        prescription_photo_key, status, order_note, delivery_type, delivery_address,
        total_amount, payment_status, payment_mode, amount_collected,
        partial_dispense, partial_reason, receipt_delivery, payment_metadata,
        dispense_label, dispensed_medications, dispensed_at,
        assigned_pharmacist, token_number, order_number,
        confirmation_notes, items_list, cancellation_reason, cancelled_at,
        facility_id, created_at, updated_at, confirmed_at, preparing_at, dispatched_at, delivered_at
       FROM pharmacy_orders WHERE id=$1 AND tenant_id=$2::uuid AND facility_id=$3::int`,
      parseInt(id), tenantId, facility.id);
    if (!order.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);

    const history = await prisma.$queryRawUnsafe(
      `SELECT id, order_id, from_status, to_status, changed_by, changed_by_role, notes, created_at
       FROM pharmacy_order_history
       WHERE order_id=$1 AND tenant_id=$2::uuid ORDER BY created_at ASC`,
      parseInt(id), tenantId);

    await attachSignedUrl(order[0]);

    auditPharmacyOrder(req, 'PHARMACY_ORDER_VIEWED', order[0], {
      history_count: history.length,
    });

    success(res, { order: order[0], history }, 'Order detail');
  } catch (err) {
    return relayAppError(res, err, 'Failed to fetch order detail');
  }
};

/**
 * GET /pharmacy/orders/:id/label
 *
 * Returns the dispense label as JSON so the staff/patient app can render
 * it (with paediatric weight, measuring-cup instructions, and dosing
 * schedule) or hand off to the receipt printer. Available once the order
 * has been DISPENSED or DELIVERED; the stored `dispense_label` snapshot
 * is the source of truth, with a freshly-computed fallback so legacy
 * orders that pre-date column 201 still produce a label.
 *
 * Closes:
 *   2026-05-09-pediatric-opd-pharmacy-no-label-endpoint
 *   2026-05-09-walk-in-opd-pharmacy-no-label-endpoint (delivery flow shares the endpoint)
 */
export const getDispenseLabel = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const orderId = pharmacyOrderIdOrNull(req.params.id);
    if (!orderId) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT po.id, po.uid, po.patient_id, po.patient_name, po.patient_phone, po.phone,
              po.order_number, po.status, po.delivery_type, po.total_amount,
              po.payment_status, po.payment_mode, po.amount_collected,
              po.partial_dispense, po.partial_reason, po.receipt_delivery,
              po.payment_metadata, po.dispense_label, po.items_list,
              po.confirmation_notes, po.dispensed_at, po.delivered_at,
              po.created_at,
              u.birthday AS patient_birthday,
              (SELECT vc.weight_kg FROM vitals_chart vc
                 JOIN users vu ON vu.uid = vc.patient_uid AND vu.tenant_id=po.tenant_id
                WHERE vu.id = po.patient_id AND vc.tenant_id=po.tenant_id
                  AND vc.weight_kg IS NOT NULL
                ORDER BY vc.recorded_at DESC NULLS LAST LIMIT 1) AS latest_weight_kg,
              NULL::text[] AS allergies
         FROM pharmacy_orders po
         LEFT JOIN users u ON u.id = po.patient_id AND u.tenant_id=po.tenant_id
        WHERE po.id = $1 AND po.tenant_id=$2::uuid AND po.facility_id=$3::int`,
      orderId, tenantId, facility.id,
    );
    if (!rows.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    const o = rows[0];

    const allergyContext = await setTenantTx(tenantId, (tx) => (
      getUnifiedActiveAllergiesDetailed(tx, { patientId: o.patient_id })
    ));
    o.allergies = allergyContext.allergies.map((a) => a.allergen);
    o.allergy_status = allergyContext.patientResolved
      && allergyContext.sourcesFailed.length === 0
      ? 'verified'
      : 'unavailable';
    o.allergy_sources_failed = allergyContext.sourcesFailed;

    const items = Array.isArray(o.items_list) ? o.items_list : [];
    const hasDispensedEvidence = items.some(
      (item) => Number(item?.inventory_dispensed_quantity || 0) > 0,
    );
    if (!['PARTIALLY_DISPENSED', 'DISPENSED', 'DELIVERED'].includes(o.status)
      && !(hasDispensedEvidence && ['CANCELLED', 'UNAVAILABLE'].includes(o.status))) {
      return error(
        res,
        `Label not available until order is dispensed (current status: ${o.status})`,
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    // Prefer the stored snapshot — that's what the pharmacist actually
    // saw at dispense time. Fall back to a derived label from items_list
    // for legacy orders that pre-date column 201.
    const storedLabel = o.dispense_label && typeof o.dispense_label === 'object'
      ? o.dispense_label
      : null;

    const ageYears = (() => {
      if (!o.patient_birthday) return null;
      const dob = new Date(o.patient_birthday);
      if (Number.isNaN(dob.getTime())) return null;
      const diffMs = Date.now() - dob.getTime();
      return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365.25));
    })();
    const weightKg = o.latest_weight_kg != null ? Number(o.latest_weight_kg) : null;

    const labelItems = (storedLabel?.items ?? items).map((i) => ({
      name: i.name || i.medication_name || null,
      strength: i.strength ?? null,
      dose: i.dose ?? i.prescribed_dose ?? null,
      frequency: i.frequency ?? null,
      duration: i.duration ?? null,
      route: i.route ?? null,
      dispensed_qty: i.dispensed_qty ?? i.qty ?? null,
      dispensed_quantity_ml: i.dispensed_quantity_ml ?? null,
      child_weight_kg: i.child_weight_kg ?? null,
      measuring_instruction: i.measuring_instruction ?? null,
      label_instruction: i.label_instruction ?? i.instructions ?? null,
    }));

    const label = {
      order_number: o.order_number,
      order_id: o.id,
      patient: {
        name: o.patient_name,
        phone: o.patient_phone || o.phone,
        age_years: ageYears,
        weight_kg: weightKg,
        allergies: Array.isArray(o.allergies) ? o.allergies : [],
        allergy_status: o.allergy_status,
        allergy_sources_failed: o.allergy_sources_failed,
        allergy_warning: o.allergy_status === 'verified'
          ? null
          : 'ALLERGY DATA UNAVAILABLE — pharmacist must manually verify allergies before handover',
      },
      items: labelItems,
      partial_dispense: o.partial_dispense ?? false,
      partial_reason: o.partial_reason ?? null,
      payment: {
        status: o.payment_status,
        mode: o.payment_mode,
        amount_collected: o.amount_collected != null ? Number(o.amount_collected) : null,
        total_amount: o.total_amount != null ? Number(o.total_amount) : null,
        metadata: o.payment_metadata ?? null,
      },
      receipt_delivery: o.receipt_delivery,
      confirmation_notes: o.confirmation_notes,
      dispensed_at: o.dispensed_at ?? o.delivered_at ?? null,
      // Paediatric measuring-cup helper. The dispensing pharmacist usually
      // writes "2.5 ml = ½ tsp" by hand; surface a stock conversion when
      // the label has any ml-based instruction so the patient/staff app
      // can render the same hint in print.
      measuring_guide: labelItems.some((i) =>
        (i.dispensed_quantity_ml ?? null) != null ||
        /\d+\s*ml\b/i.test(String(i.dose ?? '')) ||
        /\d+\s*ml\b/i.test(String(i.label_instruction ?? '')),
      )
        ? { '5_ml': '1 teaspoon', '2_5_ml': '½ teaspoon', '15_ml': '1 tablespoon' }
        : null,
    };

    success(res, label, 'Dispense label');
  } catch (err) {
    return relayAppError(res, err, 'Failed to fetch label');
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

export const getCatalog = async (req, res) => {
  try {
    const tenantId = requireTenantId(req.tenantId);
    const { category, search } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    let where = 'WHERE pharmacy_catalog.tenant_id=$1::uuid AND pharmacy_catalog.is_active=TRUE';
    const params = [tenantId];
    let orderBy = 'ORDER BY category, name';

    if (category) {
      params.push(category);
      where += ` AND category=$${params.length}`;
    }
    if (search) {
      const cleanSearch = String(search).trim();
      params.push(cleanSearch);
      const exactParam = params.length;
      params.push(`${cleanSearch}%`);
      const prefixParam = params.length;
      params.push(`%${cleanSearch}%`);
      const containsParam = params.length;
      where += ` AND (name ILIKE $${containsParam} OR generic_name ILIKE $${containsParam})`;
      orderBy = `ORDER BY
        CASE
          WHEN LOWER(name) = LOWER($${exactParam}) THEN 0
          WHEN name ILIKE $${prefixParam} THEN 1
          WHEN generic_name ILIKE $${prefixParam} THEN 2
          WHEN name ILIKE $${containsParam} THEN 3
          WHEN generic_name ILIKE $${containsParam} THEN 4
          ELSE 5
        END,
        (COALESCE(stock_quantity, stock, 0) > 0) DESC,
        COALESCE(stock_quantity, stock, 0) DESC,
        name`;
    }
    params.push(limit);

    const result = await prisma.$queryRawUnsafe(
      `SELECT pharmacy_catalog.id AS id, name, generic_name, category, manufacturer, price, unit_price, pack_size,
              COALESCE(stock_quantity, stock) AS stock,
              in_stock, is_available, requires_prescription, reorder_level, description,
              pharmacy_catalog.created_at AS created_at,
              pharmacy_catalog.composition_id, dc.display_label AS composition_label,
              pharmacy_catalog.strength, pharmacy_catalog.strength_key, pharmacy_catalog.form,
              pharmacy_catalog.form_key, pharmacy_catalog.release_key, pharmacy_catalog.composition_confidence
       FROM pharmacy_catalog
       LEFT JOIN drug_compositions dc ON dc.id = pharmacy_catalog.composition_id
       ${where} ${orderBy}
       LIMIT $${params.length}`,
      ...params
    );
    success(res, result, 'Catalog');
  } catch (err) {
    logger.error('Get pharmacy catalog error:', err);
    error(res, 'Failed to fetch catalog', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// --- Same-composition alternatives (Phase 2, gated) helpers ------------------
//
// Pure/testable. A brand is only tagged `substitutable` when every clinical
// identity dimension matches the selected brand; otherwise the sibling is shown
// as informational (same molecule set, different strength/form/split/etc.).

// A null/empty release_key normalises to 'ir' (immediate-release default), so
// two brands that both omit the modifier count as a release match.
function normalizeReleaseKey(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === '' ? 'ir' : text;
}

// Route match: both null → match (route not asserted on either); else both must
// be present AND equal (case-insensitive, trimmed). A one-sided route → no match.
function routesMatch(a, b) {
  const aHas = a !== null && a !== undefined && String(a).trim() !== '';
  const bHas = b !== null && b !== undefined && String(b).trim() !== '';
  if (!aHas && !bHas) return true;
  if (!aHas || !bHas) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Deep, order-insensitive set-equality of two strength_components arrays, each
// element shaped { ingredient, amount, unit }. Used for the combo per-ingredient
// gate: two combos with the same total strength_key but a different split (e.g.
// 500+125 vs 400+100) must NOT be substitutable.
function strengthComponentsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const norm = (c) =>
    `${String(c?.ingredient ?? '').trim().toLowerCase()}|` +
    `${String(c?.amount ?? '').trim()}|` +
    `${String(c?.unit ?? '').trim().toLowerCase()}`;
  const bag = new Map();
  for (const c of a) {
    const k = norm(c);
    bag.set(k, (bag.get(k) ?? 0) + 1);
  }
  for (const c of b) {
    const k = norm(c);
    const n = bag.get(k);
    if (!n) return false;
    bag.set(k, n - 1);
  }
  for (const n of bag.values()) {
    if (n !== 0) return false;
  }
  return true;
}

// strength_components may arrive as a JSON string or already-parsed array
// depending on the driver — normalise to an array (or null).
function asComponentArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * GET /pharmacy-orders/catalog/:id/alternatives
 *
 * Keyed by a CATALOG id (never a client composition id), tenant-scoped, gated by
 * the per-tenant composition-search flag. Returns other brands sharing the
 * selected brand's composition, grouped by strength+form (matched group first),
 * in-stock first, each tagged with a server-derived `substitutable` boolean and
 * an `availability_status`.
 */
export const getCatalogAlternatives = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > PG_INT4_MAX) {
    throw AppError.badRequest('Valid catalog id is required');
  }

  const tenantId = req.tenantId;
  const facility = await resolvePharmacyFacility(prisma, {
    tenantId,
    ...pharmacyFacilityActorFromRequest(req),
    requestedFacilityId: requestedPharmacyFacilityId(req),
  });

  // Flag OFF is a valid empty answer (not a 404).
  if (!(await isCompositionSearchEnabled(tenantId))) {
    return success(res, { selected: null, groups: [], alternatives: [] }, 'Alternatives');
  }

  // Resolve the selected row server-side from the catalog id (tenant-scoped,
  // active-only). Missing / wrong-tenant / inactive → 404.
  const selected = (await resolveCompositionIdentitiesByCatalogIds(tenantId, [id])).get(id);
  if (!selected) {
    throw AppError.notFound('Catalog item not found');
  }

  const publicSelected = {
    catalog_id: selected.catalog_id,
    composition_id: selected.composition_id,
    composition_label: selected.composition_label,
    strength: selected.strength,
    strength_key: selected.strength_key,
    form: selected.form,
    form_key: selected.form_key,
    release_key: selected.release_key,
  };

  // The brand exists but has no surfaced alternatives (no composition, or the
  // parse confidence is not high enough to trust the identity).
  if (selected.composition_id == null || selected.composition_confidence !== 'high') {
    return success(res, { selected: publicSelected, groups: [], alternatives: [] }, 'Alternatives');
  }

  try {
    // Availability is a LIVE SUM over the brand's non-expired in_stock batches (mig 586
    // linked pharmacy_inventory_items.catalog_id → pharmacy_catalog.id), so the pharmacist
    // sees which alternative brands are actually on the shelf — not coarse catalog flags.
    // Falls back to 0 (out_of_stock) for brands whose inventory isn't linked yet.
    const sql = `
      SELECT pc.id AS catalog_id, pc.name, pc.manufacturer, pc.generic_name,
             pc.strength, pc.strength_key, pc.strength_components, pc.form, pc.form_key,
             pc.release_key, pc.route, pc.composition_confidence,
             COALESCE((
               SELECT SUM(b.remaining_quantity)
                 FROM pharmacy_inventory_batches b
                 JOIN pharmacy_inventory_items i
                   ON i.id = b.inventory_item_id
                  AND i.tenant_id = b.tenant_id
                  AND i.facility_id = b.facility_id
                WHERE i.tenant_id = pc.tenant_id
                  AND i.catalog_id = pc.id
                  AND i.facility_id = $4::int
                  AND b.tenant_id = pc.tenant_id
                  AND b.facility_id = $4::int
                  AND b.status = 'in_stock'
                  AND b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
             ), 0)::numeric AS available_stock
        FROM pharmacy_catalog pc
       WHERE pc.tenant_id = $1::uuid AND pc.is_active
         AND pc.composition_id = $2 AND pc.id <> $3
       ORDER BY available_stock DESC, pc.strength_key NULLS LAST, pc.name`;
    const rows = await prisma.$queryRawUnsafe(
      sql,
      tenantId,
      selected.composition_id,
      id,
      facility.id,
    );

    // "Is this a combination drug?" is derived from the molecule count on the
    // composition (drug_compositions.active_ingredients), NOT from whether the
    // per-ingredient strength split happened to parse. A genuinely-combination
    // brand curated as high-confidence but WITHOUT a usable strength_components
    // split (a path the manual curation tool can produce) must still be treated
    // as a combo so the per-ingredient gate is not silently skipped.
    const selectedComponents = asComponentArray(selected.strength_components);
    const selectedIsCombo =
      (Array.isArray(selected.active_ingredients) && selected.active_ingredients.length >= 2) ||
      (Array.isArray(selectedComponents) && selectedComponents.length >= 2);

    // Fail-safe: if the selected drug is a combination but we cannot confirm ITS
    // OWN per-ingredient split (strength_components missing / < 2 elements), then
    // no sibling can be proven an exact-split match — force every sibling to
    // non-substitutable (informational only). Decided once, up front, so it
    // applies uniformly across the response.
    const selectedSplitUnconfirmable =
      selectedIsCombo &&
      !(Array.isArray(selectedComponents) && selectedComponents.length >= 2);

    const alternatives = rows.map((r) => {
      const catalogId = Number(r.catalog_id);
      const availableStock =
        r.available_stock === null || r.available_stock === undefined
          ? 0
          : Number(r.available_stock);
      // Real batch stock → binary in/out; no more coarse "may_be_available" flag guess.
      const availabilityStatus = availableStock > 0 ? 'in_stock' : 'out_of_stock';

      // Substitutable only when EVERY identity dimension matches.
      let substitutable =
        r.composition_confidence === 'high' &&
        Boolean(r.strength_key) && r.strength_key === selected.strength_key &&
        Boolean(r.form_key) && r.form_key === selected.form_key &&
        normalizeReleaseKey(r.release_key) === normalizeReleaseKey(selected.release_key) &&
        routesMatch(r.route, selected.route);

      // Combo per-ingredient gate: a combination selected must match the
      // sibling's exact per-ingredient split; a sibling missing components
      // cannot be confirmed → not substitutable. If the SELECTED drug's own
      // split is unconfirmable, no sibling can be substitutable at all.
      if (substitutable && selectedIsCombo) {
        if (selectedSplitUnconfirmable) {
          substitutable = false;
        } else {
          const sibComponents = asComponentArray(r.strength_components);
          if (!Array.isArray(sibComponents) || sibComponents.length === 0) {
            substitutable = false;
          } else if (!strengthComponentsEqual(selectedComponents, sibComponents)) {
            substitutable = false;
          }
        }
      }

      return {
        catalog_id: catalogId,
        name: r.name ?? null,
        manufacturer: r.manufacturer ?? null,
        generic_name: r.generic_name ?? null,
        strength: r.strength ?? null,
        strength_key: r.strength_key ?? null,
        form: r.form ?? null,
        form_key: r.form_key ?? null,
        release_key: r.release_key ?? null,
        route: r.route ?? null,
        stock_quantity: availableStock,
        available_stock: availableStock,
        availability_status: availabilityStatus,
        substitutable,
      };
    });

    // Group by strength_key + form_key, preserving the in-stock-first query
    // order within each group.
    const groupMap = new Map();
    for (const item of alternatives) {
      const key = `${item.strength_key ?? ''}||${item.form_key ?? ''}`;
      let group = groupMap.get(key);
      if (!group) {
        group = {
          strength_key: item.strength_key,
          form_key: item.form_key,
          strength: item.strength,
          form: item.form,
          matched:
            item.strength_key === selected.strength_key &&
            item.form_key === selected.form_key,
          items: [],
        };
        groupMap.set(key, group);
      }
      group.items.push(item);
    }

    // Matched group first, then by strength_key (nulls last), then form_key.
    const groups = [...groupMap.values()].sort((g1, g2) => {
      if (g1.matched !== g2.matched) return g1.matched ? -1 : 1;
      const s1 = g1.strength_key ?? '￿';
      const s2 = g2.strength_key ?? '￿';
      if (s1 !== s2) return s1 < s2 ? -1 : 1;
      const f1 = g1.form_key ?? '￿';
      const f2 = g2.form_key ?? '￿';
      return f1 < f2 ? -1 : f1 > f2 ? 1 : 0;
    });

    return success(res, { selected: publicSelected, groups, alternatives }, 'Alternatives');
  } catch (err) {
    logger.error('Get pharmacy catalog alternatives error:', err);
    return error(res, 'Failed to fetch alternatives', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Server-side equivalence gate for a dispense-substitution — mirrors the /alternatives
// `substitutable` rule so a pharmacist can never dispense an inequivalent brand even if a
// client posts arbitrary catalog ids. Both identities are server-resolved beforehand.
function substitutionAllowed(orig, sub) {
  if (!orig || !sub) return false;
  if (orig.composition_id == null || orig.composition_id !== sub.composition_id) return false;
  if (orig.composition_confidence !== 'high' || sub.composition_confidence !== 'high') return false;
  if (!orig.strength_key || orig.strength_key !== sub.strength_key) return false;
  if (!orig.form_key || orig.form_key !== sub.form_key) return false;
  if (normalizeReleaseKey(orig.release_key) !== normalizeReleaseKey(sub.release_key)) return false;
  if (!routesMatch(orig.route, sub.route)) return false;
  const oc = asComponentArray(orig.strength_components);
  const sc = asComponentArray(sub.strength_components);
  const isCombo = (Array.isArray(orig.active_ingredients) && orig.active_ingredients.length >= 2)
    || (Array.isArray(oc) && oc.length >= 2);
  if (isCombo) {
    if (!Array.isArray(oc) || oc.length < 2 || !Array.isArray(sc) || sc.length < 2) return false;
    if (!strengthComponentsEqual(oc, sc)) return false;
  }
  return true;
}

// Schedule classes whose shelf decrement must go through the statutory
// pharmacy_schedule_register path (mirrors inventoryV2Service.dispenseControlledTx
// and counterSaleService.isControlled — no parallel controlled mechanism).
const SUBSTITUTION_CONTROLLED_SCHEDULE_CLASSES = ['H', 'H1', 'X'];

/**
 * Phase 0 of a dispense-substitution (reads only, shared by the dispense
 * handler and the witness request/approve endpoints): parse + validate the
 * ids, server-resolve BOTH catalog identities tenant-scoped, confirm the swap
 * is genuinely equivalent, and read the dispensed item's controlled-substance
 * classification. The schedule check keys off the CONCRETE inventory item
 * being decremented — never a client-supplied brand string.
 */
export async function resolveSubstitutionPhase0(tenantId, body = {}, db = prisma) {
  if (Object.hasOwn(body, 'performed_by_name')) {
    throw AppError.badRequest(
      'performed_by_name is derived from the authenticated roster identity',
      'SUBSTITUTION_PERFORMER_NAME_FORBIDDEN',
    );
  }
  const {
    order_id, prescription_id, patient_uid, encounter_id, inventory_item_id, inventory_batch_id,
    quantity, original_catalog_id, final_catalog_id, order_line_index, prescription_line_index,
    reason,
  } = body;

  const qty = canonicalSubstitutionQuantity(quantity);
  const origId = Number(original_catalog_id);
  const finalId = Number(final_catalog_id);
  const itemId = Number(inventory_item_id);
  const batchId = Number(inventory_batch_id);
  const orderId = Number(order_id);
  const prescriptionId = Number(prescription_id);
  const orderLineIndex = Number(order_line_index);
  const prescriptionLineIndex = Number(prescription_line_index);

  if (origId === finalId) {
    throw AppError.badRequest('Substitute must differ from the original brand', 'SUBSTITUTE_SAME_AS_ORIGINAL');
  }
  if (
    !Number.isInteger(itemId) || itemId <= 0 || itemId > PG_INT4_MAX
    || !Number.isInteger(batchId) || batchId <= 0 || batchId > PG_INT4_MAX
    || !Number.isInteger(orderId) || orderId <= 0 || orderId > PG_INT4_MAX
    || !Number.isInteger(prescriptionId) || prescriptionId <= 0
    || prescriptionId > PG_INT4_MAX
    || !Number.isSafeInteger(orderLineIndex) || orderLineIndex < 0
    || orderLineIndex > PG_INT4_MAX
    || !Number.isSafeInteger(prescriptionLineIndex) || prescriptionLineIndex < 0
    || prescriptionLineIndex > PG_INT4_MAX
    || !Number.isInteger(origId) || origId <= 0 || origId > PG_INT4_MAX
    || !Number.isInteger(finalId) || finalId <= 0 || finalId > PG_INT4_MAX
  ) {
    throw AppError.badRequest(
      'Valid order_id, prescription_id, order_line_index, prescription_line_index, inventory_item_id, inventory_batch_id, quantity, original_catalog_id and final_catalog_id are required',
    );
  }
  if (!patient_uid) {
    throw AppError.badRequest('Valid patient UID required');
  }

  const links = await db.$queryRawUnsafe(
    `SELECT po.id AS order_id, po.status AS order_status, po.items_list, po.facility_id,
            po.clinical_verification_status, po.inventory_authority_version,
            po.clinically_verified_order_version, po.clinical_verification_items_sha256,
            ep.id AS prescription_id, ep.status AS prescription_status,
            ep.medications, ep.prescription_number, ep.doctor_uid,
            ep.appointment_id, ep.admission_id
       FROM pharmacy_orders po
       JOIN e_prescriptions ep
         ON ep.pharmacy_order_id = po.id
        AND ep.tenant_id = po.tenant_id
        AND ep.patient_id = po.patient_id
       JOIN users patient
         ON patient.tenant_id=po.tenant_id
        AND patient.id=po.patient_id
        AND patient.uid=ep.patient_uid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      WHERE po.id = $1::int
        AND ep.id = $2::int
        AND po.tenant_id = $3::uuid
        AND ep.patient_uid = $4::uuid
      LIMIT 1`,
    orderId,
    prescriptionId,
    tenantId,
    String(patient_uid),
  );
  if (!links.length) {
    throw AppError.notFound(
      'The originating pharmacy order and prescription linkage was not found for this patient',
      'SUBSTITUTION_ORIGIN_LINK_NOT_FOUND',
    );
  }
  const link = links[0];
  if (!Number(link.facility_id)) {
    throw AppError.conflict(
      'The originating pharmacy order has no authoritative facility assignment',
      'PHARMACY_ORDER_FACILITY_UNRESOLVED',
      { recovery_action: 'contact_admin_to_assign_legacy_order_facility' },
    );
  }
  if (!['PENDING', 'CONFIRMED', 'PREPARING', 'PARTIALLY_DISPENSED']
    .includes(link.order_status)) {
    throw AppError.conflict(
      `Order ${orderId} cannot accept a substitution from status ${link.order_status}`,
      'SUBSTITUTION_ORDER_STATUS_INVALID',
    );
  }
  if (!['active', 'pharmacy_linked'].includes(String(link.prescription_status || '').toLowerCase())) {
    throw AppError.conflict(
      `Prescription ${prescriptionId} cannot be dispensed from status ${link.prescription_status || 'unknown'}`,
      'SUBSTITUTION_PRESCRIPTION_STATUS_INVALID',
    );
  }
  const medications = Array.isArray(link.medications) ? link.medications : [];
  const prescriptionLine = medications[prescriptionLineIndex];
  if (!prescriptionLine || Number(prescriptionLine.catalog_id) !== origId) {
    throw AppError.conflict(
      'The exact prescribed line identity no longer matches the requested original catalog',
      'SUBSTITUTION_PRESCRIPTION_LINE_CHANGED',
    );
  }
  const orderLines = Array.isArray(link.items_list) ? link.items_list : [];
  const orderLine = orderLines[orderLineIndex];
  if (!orderLine
    || Number(orderLine.order_line_index) !== orderLineIndex
    || Number(orderLine.prescription_line_index) !== prescriptionLineIndex
    || ![Number(orderLine.catalog_id), ...(Array.isArray(orderLine.substitution_history)
      ? orderLine.substitution_history.map((entry) => Number(entry?.original_catalog_id))
      : [])].includes(origId)) {
    throw AppError.conflict(
      'The exact order line identity no longer matches the linked prescription line',
      'SUBSTITUTION_ORDER_LINE_MISMATCH',
    );
  }
  const prescribedQuantity = positiveQuantity(
    prescriptionLine.quantity ?? prescriptionLine.qty,
    'prescription quantity',
  );
  const previouslyDispensed = Math.max(0, Number(prescriptionLine.dispensed_quantity || 0));
  const remainingQuantity = Number.isFinite(Number(prescriptionLine.remaining_quantity))
    ? Number(prescriptionLine.remaining_quantity)
    : prescribedQuantity - previouslyDispensed;
  if (!Number.isFinite(remainingQuantity) || remainingQuantity < 0) {
    throw AppError.conflict(
      'Prescription fulfilment evidence is inconsistent',
      'SUBSTITUTION_PRESCRIPTION_FULFILMENT_CONFLICT',
    );
  }
  if (qty - remainingQuantity > 0.000001) {
    throw AppError.conflict(
      `Substitution quantity exceeds the prescription remainder (${remainingQuantity})`,
      'SUBSTITUTION_QUANTITY_EXCEEDS_REMAINDER',
      { remaining_quantity: remainingQuantity },
    );
  }

  const ids = await resolveCompositionIdentitiesByCatalogIds(
    tenantId,
    [origId, finalId],
    { db },
  );
  const orig = ids.get(origId);
  const sub = ids.get(finalId);
  if (!orig || !sub) throw AppError.badRequest('Unresolvable catalog id', 'CATALOG_ID_UNRESOLVED');
  if (!substitutionAllowed(orig, sub)) {
    throw AppError.badRequest('Selected brand is not an equivalent substitute', 'SUBSTITUTE_NOT_EQUIVALENT');
  }

  const items = await db.$queryRawUnsafe(
    `SELECT id, catalog_id, facility_id, schedule_class, is_narcotic
       FROM pharmacy_inventory_items
      WHERE id = $1::int AND tenant_id = $2::uuid
        AND facility_id = $3::int AND status = 'active'`,
    itemId, tenantId, Number(link.facility_id),
  );
  if (!items.length) throw AppError.notFound('Inventory item not found');
  const item = items[0];
  if (Number(item.catalog_id) !== finalId) {
    throw AppError.badRequest(
      'inventory_item_id is not linked to final_catalog_id',
      'SUBSTITUTION_INVENTORY_CATALOG_MISMATCH',
    );
  }
  const controlled = SUBSTITUTION_CONTROLLED_SCHEDULE_CLASSES.includes(item.schedule_class)
    || item.is_narcotic === true;
  const needsWitness = item.schedule_class === 'X' || item.is_narcotic === true;

  const encounterRows = (link.appointment_id != null || link.admission_id != null)
    ? await db.$queryRawUnsafe(
      `SELECT id
         FROM patient_encounters
        WHERE tenant_id=$1::uuid
          AND patient_uid=$2::uuid
          AND (($3::int IS NOT NULL AND appointment_id=$3::int)
            OR ($4::int IS NOT NULL AND admission_id=$4::int))
        ORDER BY id
        LIMIT 2`,
      tenantId,
      String(patient_uid),
      link.appointment_id == null ? null : Number(link.appointment_id),
      link.admission_id == null ? null : Number(link.admission_id),
    )
    : [];
  if (encounterRows.length > 1) {
    throw AppError.conflict(
      'The linked prescription resolves to more than one patient encounter',
      'SUBSTITUTION_ENCOUNTER_AUTHORITY_AMBIGUOUS',
    );
  }
  const authoritativeEncounterId = encounterRows[0]?.id || null;
  if (encounter_id != null && String(encounter_id) !== String(authoritativeEncounterId || '')) {
    throw AppError.conflict(
      'encounter_id does not belong to the linked prescription and patient',
      'SUBSTITUTION_ENCOUNTER_AUTHORITY_CHANGED',
    );
  }

  return {
    patient_uid, encounter_id: authoritativeEncounterId, reason,
    orderId, prescriptionId, qty, origId, finalId, itemId, batchId,
    orderLineIndex, prescriptionLineIndex, facilityId: Number(link.facility_id),
    orig, sub, item, controlled, needsWitness, link,
    prescribedQuantity,
    previouslyDispensed,
    remainingQuantity,
  };
}

/**
 * POST /pharmacy-orders/dispense-substitution/witness-approvals
 *
 * Dispensing pharmacist creates a short-lived pending witness approval bound
 * to the authenticated dispenser and the exact prospective substitution
 * payload. Only available when the concrete inventory item is Schedule X /
 * narcotic (the only substitutions that statutorily need a witness); the
 * same equivalence gate as the dispense runs first so an approval can never
 * exist for an inequivalent swap.
 */
export async function requestSubstitutionWitnessApproval({
  tenantId,
  requested_by,
  requested_role,
  ...body
}) {
  if (Object.hasOwn(body, 'witness_approval_id')) {
    throw AppError.badRequest(
      'witness_approval_id is not accepted before witness approval',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_PRESELECTED',
    );
  }
  const ctx = await setTenantTx(tenantId, async (tx) => {
    const resolved = await resolveSubstitutionPhase0(tenantId, body, tx);
    if (!resolved.needsWitness) {
      throw AppError.badRequest(
        'A witness approval is only available for Schedule X / narcotic substitution',
        'CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED',
      );
    }
    await assertPharmacyFacilityGrant(tx, {
      tenantId,
      facilityId: resolved.facilityId,
      actorUid: requested_by,
      actorRole: requested_role,
      forUpdate: true,
    });
    // Advisory usable-batch check (the dispense revalidates under FOR UPDATE).
    const batches = await tx.$queryRawUnsafe(
      `SELECT id, remaining_quantity, status,
              (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
         FROM pharmacy_inventory_batches
        WHERE id = $1::int AND tenant_id = $2::uuid AND inventory_item_id = $3::int
          AND facility_id = $4::int`,
      resolved.batchId, tenantId, resolved.itemId, resolved.facilityId,
    );
    if (!batches.length) throw AppError.notFound('Inventory batch not found');
    if (batches[0].status !== 'in_stock') {
      throw AppError.badRequest(
        `Batch not available for issue (status: ${batches[0].status})`,
        'INVENTORY_BATCH_UNAVAILABLE',
      );
    }
    if (batches[0].is_expired) {
      throw AppError.badRequest('Batch is expired and cannot be issued', 'INVENTORY_BATCH_EXPIRED');
    }
    if (Number(batches[0].remaining_quantity) < resolved.qty) {
      throw AppError.badRequest(
        `Insufficient stock. Available: ${batches[0].remaining_quantity}`,
        'INVENTORY_INSUFFICIENT_STOCK',
      );
    }
    return resolved;
  });
  const {
    CONTROLLED_DISPENSE_APPROVAL_SCOPES, createControlledDispenseWitnessApproval,
  } = await import('../../services/pharmacy/controlledDispenseWitnessService.js');
  return createControlledDispenseWitnessApproval({
    tenantId,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.dispenseSubstitution,
    payload: substitutionWitnessPayload({ ...body, quantity: ctx.qty }),
    requestedBy: requested_by,
  });
}

async function resolveSubstitutionWitnessApprovalPayloadTx({
  tx,
  tenantId,
  body,
  scope,
  expectedScope,
}) {
  if (scope !== expectedScope) {
    throw AppError.conflict(
      'Witness approval does not match a dispense substitution',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    );
  }
  const ctx = await resolveSubstitutionPhase0(tenantId, body, tx);
  if (!ctx.needsWitness) {
    throw AppError.badRequest(
      'A witness approval is only available for Schedule X / narcotic substitution',
      'CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED',
    );
  }
  return substitutionWitnessPayload({ ...body, quantity: ctx.qty });
}

export async function preflightSubstitutionWitnessApproval({
  approvalId,
  requesterUid = null,
  substitution,
}) {
  const { tenantId, ...body } = substitution || {};
  const {
    CONTROLLED_DISPENSE_APPROVAL_SCOPES,
    preflightControlledDispenseWitnessApproval,
  } = await import('../../services/pharmacy/controlledDispenseWitnessService.js');
  const scope = CONTROLLED_DISPENSE_APPROVAL_SCOPES.dispenseSubstitution;
  return preflightControlledDispenseWitnessApproval({
    tenantId,
    approvalId,
    scope,
    requesterUid,
    resolvePayload: ({ tx, scope: approvalScope }) => (
      resolveSubstitutionWitnessApprovalPayloadTx({
        tx,
        tenantId,
        body,
        scope: approvalScope,
        expectedScope: scope,
      })
    ),
  });
}

/**
 * POST /pharmacy-orders/dispense-substitution/witness-approvals/:id/approve
 *
 * A separately authenticated eligible witness approves the unchanged
 * substitution payload. Self-witness, tenant mismatch, expiry, replay, and
 * payload changes fail closed inside controlledDispenseWitnessService.
 */
export async function approveSubstitutionWitnessApproval({
  approvalId, actorUid, requesterUid = null, substitution,
}) {
  const { tenantId, ...body } = substitution || {};
  const {
    CONTROLLED_DISPENSE_APPROVAL_SCOPES,
    approveControlledDispenseWitnessApproval,
  } = await import('../../services/pharmacy/controlledDispenseWitnessService.js');
  const scope = CONTROLLED_DISPENSE_APPROVAL_SCOPES.dispenseSubstitution;
  return approveControlledDispenseWitnessApproval({
    tenantId,
    approvalId,
    actorUid,
    scope,
    requesterUid,
    resolvePayload: ({ tx, scope: approvalScope }) => (
      resolveSubstitutionWitnessApprovalPayloadTx({
        tx,
        tenantId,
        body,
        scope: approvalScope,
        expectedScope: scope,
      })
    ),
  });
}

/**
 * POST /pharmacy-orders/dispense-substitution
 *
 * Pharmacist dispenses an in-stock same-formulation alternative in place of the
 * prescribed brand. Atomic in one tenant-scoped transaction: locks + validates +
 * decrements the chosen batch, then writes the canonical clinical timeline + audit pair
 * (hard-fail — rolls back the decrement if either event cannot be recorded). A best-
 * effort brand-substitution audit follows post-commit. Both catalog ids are re-resolved
 * server-side and the swap is re-checked for equivalence; client brand strings are never
 * trusted.
 *
 * The inventory service owns exact-batch locking, durable command replay, controlled
 * custody, and the order/prescription/billing projections in one transaction.
 */
export const dispenseSubstitution = async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const body = req.body ?? {};
    if (Object.hasOwn(body, 'performed_by_name')) {
      throw AppError.badRequest(
        'performed_by_name is derived from the authenticated roster identity',
        'SUBSTITUTION_PERFORMER_NAME_FORBIDDEN',
      );
    }
    const orderId = Number(body.order_id);
    const prescriptionId = Number(body.prescription_id);
    const commandKeySha256 = dispenseCommandKey(
      req,
      `substitution:${orderId}:${prescriptionId}`,
    );
    const result = await dispenseSubstitutionCommand({
      tenantId,
      body,
      contextResolver: (tx) => resolveSubstitutionPhase0(tenantId, body, tx),
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      commandKeySha256,
      requestId: req.id,
    });
    return success(res, result, 'Substitution dispensed');
  } catch (err) {
    return relayAppError(res, err, 'Failed to dispense substitution');
  }
};

/**
 * GET /pharmacy-orders/orders/:id/dispensable
 *
 * The patient + prescribed medication lines (each with its catalog_id) behind a pharmacy
 * order — the context a pharmacist needs to dispense a same-formulation substitute. Tenant-
 * scoped. `encounter_id` is not modelled on the order→Rx path (appointment_id/admission_id
 * are surfaced instead). An order with no linked prescription lines returns empty lines.
 */
export const getOrderDispensableContext = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > PG_INT4_MAX) {
    throw AppError.badRequest('Valid order id is required');
  }
  try {
    const tenantId = requireTenantId(req.tenantId);
    const facility = await resolveOrderPharmacyFacility(prisma, {
      tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      orderId: id,
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT po.id AS order_id, po.facility_id, po.items_list, po.delivery_type,
              po.total_amount, po.payment_mode, po.payment_status, po.amount_collected,
              po.payment_metadata,
              patient.uid AS order_patient_uid,
              (SELECT COUNT(*)::int
                 FROM e_prescriptions raw_ep
                WHERE raw_ep.tenant_id=po.tenant_id
                  AND raw_ep.pharmacy_order_id=po.id) AS raw_link_count,
              ep.id AS prescription_id, ep.patient_uid, ep.appointment_id,
              ep.admission_id, ep.medications
         FROM pharmacy_orders po
         LEFT JOIN users patient
          ON patient.tenant_id=po.tenant_id
          AND patient.id=po.patient_id
          AND patient.role='PATIENT'
          AND patient.is_active=TRUE
          AND patient.status='active'
          AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
         LEFT JOIN e_prescriptions ep
           ON ep.pharmacy_order_id = po.id
          AND ep.tenant_id = po.tenant_id
          AND ep.patient_id=po.patient_id
          AND ep.patient_uid=patient.uid
        WHERE po.id = $1 AND po.tenant_id = $2::uuid AND po.facility_id=$3::int
        ORDER BY ep.id`,
      id, tenantId, facility.id,
    );
    if (!rows.length) {
      return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    }
    if (rows.length > 1) {
      throw AppError.conflict(
        'Pharmacy order is linked to more than one prescription',
        'PHARMACY_ORDER_PRESCRIPTION_LINK_AMBIGUOUS',
      );
    }
    const row = rows[0];
    const prescriptionId = row.prescription_id == null ? null : Number(row.prescription_id);
    if (Number(row.raw_link_count || 0) !== (prescriptionId == null ? 0 : 1)
      || (row.patient_uid != null && row.order_patient_uid == null)) {
      throw AppError.conflict(
        'The linked prescription does not match the active order patient authority',
        'PHARMACY_ORDER_PRESCRIPTION_PATIENT_MISMATCH',
        { recovery_action: 'resolve_prescription_order_patient_authority' },
      );
    }
    const orderItems = Array.isArray(row.items_list) ? row.items_list : [];
    const medications = Array.isArray(row.medications) ? row.medications : [];
    const lines = prescriptionId == null ? [] : orderItems.map((line, orderLineIndex) => {
      const prescriptionLineIndex = Number(line?.prescription_line_index);
      const medication = Number.isSafeInteger(prescriptionLineIndex)
        && prescriptionLineIndex >= 0
        ? medications[prescriptionLineIndex]
        : null;
      const prescribedCatalogId = Number(medication?.catalog_id);
      const currentCatalogId = Number(line?.catalog_id);
      const substitutionHistory = [
        ...(Array.isArray(line?.substitution_history) ? line.substitution_history : []),
        ...(Array.isArray(medication?.substitution_history)
          ? medication.substitution_history
          : []),
      ];
      const substitutionProvesCurrentCatalog = prescribedCatalogId !== currentCatalogId
        && substitutionHistory.some((entry) => (
          Number(entry?.original_catalog_id) === prescribedCatalogId
          && Number(entry?.final_catalog_id) === currentCatalogId
        ));
      if (Number(line?.order_line_index) !== orderLineIndex
        || !medication
        || (!substitutionProvesCurrentCatalog && currentCatalogId !== prescribedCatalogId)) {
        throw AppError.conflict(
          'Prescription-bound order line identity is unresolved',
          'PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED',
          { order_line_index: orderLineIndex, prescription_line_index: Number.isSafeInteger(prescriptionLineIndex) ? prescriptionLineIndex : null },
        );
      }
      const quantity = Number(
        medication.remaining_quantity ?? medication.quantity ?? medication.qty,
      );
      return {
        prescription_id: prescriptionId,
        prescription_line_index: prescriptionLineIndex,
        order_line_index: orderLineIndex,
        catalog_id: currentCatalogId,
        prescribed_catalog_id: prescribedCatalogId,
        current_catalog_id: currentCatalogId,
        inventory_item_id: Number(line?.inventory_item_id) || null,
        inventory_allocations: Array.isArray(line?.inventory_allocation_evidence)
          ? line.inventory_allocation_evidence
          : [],
        name: line?.name ?? line?.medication_name ?? medication.name ?? medication.medication_name
          ?? medication.drug_name ?? medication.display_name ?? null,
        quantity: Number.isFinite(quantity) ? quantity : null,
      };
    });
    return success(res, {
      order_id: id,
      prescription_id: prescriptionId,
      patient_uid: row.patient_uid ?? row.order_patient_uid ?? null,
      appointment_id: row.appointment_id ?? null,
      admission_id: row.admission_id ?? null,
      facility_id: Number(row.facility_id),
      delivery_type: row.delivery_type,
      total_amount: Number(row.total_amount || 0),
      payment_mode: row.payment_mode || null,
      payment_status: row.payment_status || null,
      amount_collected: Number(row.amount_collected || 0),
      tpa_reference: row.payment_metadata?.tpa_reference
        ?? row.payment_metadata?.approval_reference
        ?? row.payment_metadata?.funding_reference
        ?? null,
      lines,
    }, 'Dispensable context');
  } catch (err) {
    return relayAppError(res, err, 'Failed to fetch dispensable context');
  }
};

/**
 * GET /pharmacy-orders/catalog/:id/dispensable-batches
 *
 * In-stock, non-expired, non-empty batches for a catalog brand (via the mig-586
 * pharmacy_inventory_items.catalog_id link), FEFO-ordered — the pharmacist's batch picker
 * for a dispense-substitution. Tenant-scoped.
 */
export const getCatalogDispensableBatches = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > PG_INT4_MAX) {
    throw AppError.badRequest('Valid catalog id is required');
  }
  try {
    const facility = await resolvePharmacyFacility(prisma, {
      tenantId: req.tenantId,
      ...pharmacyFacilityActorFromRequest(req),
      requestedFacilityId: requestedPharmacyFacilityId(req),
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT b.inventory_item_id, b.id AS inventory_batch_id, b.batch_number,
              b.remaining_quantity, b.expiry_date,
              i.schedule_class, i.is_narcotic, i.facility_id
         FROM pharmacy_inventory_batches b
         JOIN pharmacy_inventory_items i
           ON i.id = b.inventory_item_id
          AND i.tenant_id = b.tenant_id
          AND i.facility_id = b.facility_id
        WHERE i.tenant_id = $1::uuid AND i.catalog_id = $2
          AND i.facility_id = $3::int
          AND b.tenant_id = $1::uuid AND b.facility_id = $3::int
          AND b.status = 'in_stock'
          AND b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND b.remaining_quantity > 0
        ORDER BY b.expiry_date ASC, b.id`,
      req.tenantId, id, facility.id,
    );
    return success(res, {
      catalog_id: id,
      facility_id: facility.id,
      batches: rows.map((r) => ({
        inventory_item_id: Number(r.inventory_item_id),
        inventory_batch_id: Number(r.inventory_batch_id),
        batch_number: r.batch_number ?? null,
        remaining_quantity: Number(r.remaining_quantity),
        expiry_date: r.expiry_date,
        // Controlled-substance flags so the substitution UI can run the
        // Schedule X / narcotic witness flow before attempting the dispense.
        schedule_class: r.schedule_class ?? null,
        is_narcotic: r.is_narcotic === true,
      })),
    }, 'Dispensable batches');
  } catch (err) {
    return relayAppError(res, err, 'Failed to fetch dispensable batches');
  }
};

export const upsertCatalog = async (req, res) => {
  try {
    const {
      id, name, generic_name, category, manufacturer,
      unit_price, pack_size, requires_prescription,
      in_stock, stock_quantity, reorder_level
    } = req.body;

    if (!name) return error(res, 'Medicine name is required', HTTP_STATUS.BAD_REQUEST);

    // Phase 1 composition layer: derive structured identity columns on write
    // (pure/DB-free), then resolve the global composition_id via the shared
    // upsert. Additive — existing search behaviour is unchanged.
    const enriched = enrichCatalogRowForWrite({ name, generic_name });
    let compositionId = null;
    if (enriched._composition.key) {
      const cr = await prisma.$queryRawUnsafe(
        `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
         VALUES ($1,$2,$3,'parsed') ON CONFLICT (composition_key) DO UPDATE SET updated_at=NOW() RETURNING id`,
        enriched._composition.key, enriched._composition.displayLabel, enriched._composition.activeIngredients
      );
      compositionId = cr[0].id;
    }

    let result;
    if (id) {
      result = await setTenantTx(req.tenantId, (tx) => tx.$queryRawUnsafe(
        `UPDATE pharmacy_catalog SET
          name=$1, generic_name=$2, category=$3, manufacturer=$4,
          unit_price=$5, pack_size=$6, requires_prescription=$7,
          in_stock=$8, is_available=$8, stock_quantity=$9, reorder_level=$10,
          composition_id=$12, strength=$13, strength_key=$14, strength_components=$15,
          form=$16, form_key=$17, release_key=$18, route=$19,
          composition_source=$20, composition_confidence=$21, parsed_notes=$22,
          updated_at=NOW()
        WHERE id=$11 AND tenant_id=$23::uuid RETURNING id, name, generic_name, category, manufacturer,
          unit_price, pack_size, requires_prescription, in_stock, is_available, stock_quantity,
          reorder_level, updated_at`,
        name, generic_name, category, manufacturer, unit_price, pack_size,
        requires_prescription ?? true, in_stock ?? true,
        stock_quantity || 0, reorder_level || 10, id,
        compositionId, enriched.strength, enriched.strength_key, enriched.strength_components,
        enriched.form, enriched.form_key, enriched.release_key, enriched.route,
        enriched.composition_source, enriched.composition_confidence, enriched.parsed_notes,
        req.tenantId,
      ));
    } else {
      result = await setTenantTx(req.tenantId, (tx) => tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_catalog
          (tenant_id, name, generic_name, category, manufacturer, unit_price, pack_size,
           requires_prescription, in_stock, is_available, stock_quantity, reorder_level,
           composition_id, strength, strength_key, strength_components,
           form, form_key, release_key, route,
           composition_source, composition_confidence, parsed_notes)
        VALUES ($22::uuid,$1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,
           $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        RETURNING id, name, generic_name, category, manufacturer, unit_price,
          pack_size, requires_prescription, in_stock, is_available, stock_quantity, reorder_level, created_at`,
        name, generic_name || null, category || 'other', manufacturer || null,
        unit_price || null, pack_size || null, requires_prescription ?? true,
        in_stock ?? true, stock_quantity || 0, reorder_level || 10,
        compositionId, enriched.strength, enriched.strength_key, enriched.strength_components,
        enriched.form, enriched.form_key, enriched.release_key, enriched.route,
        enriched.composition_source, enriched.composition_confidence, enriched.parsed_notes,
        req.tenantId,
      ));
    }

    success(res, result[0], id ? 'Medicine updated' : 'Medicine added');
  } catch (err) {
    logger.error('Upsert pharmacy catalog error:', err);
    error(res, 'Failed to save medicine', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const removeCatalog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > PG_INT4_MAX) {
      return error(res, 'Valid medicine id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const removalCommandKey = req.idempotencyClaim?.requestKey || req.get?.('idempotency-key');
    const removalCommandSha256 = dispenseCommandKey(req, `remove-catalog:${id}`);
    const removalRequestPayload = { action: 'REMOVE_CATALOG', catalog_id: id };
    const removalRequestSha256 = pharmacyCommandRequestSha256(removalRequestPayload);
    const reopenedRecoveries = [];
    const result = await setTenantTx(req.tenantId, async (tx) => {
      await lockPharmacyCatalogAuthorityTx(tx, req.tenantId);
      const catalog = await tx.$queryRawUnsafe(
        `SELECT id, name, generic_name, category
           FROM pharmacy_catalog
          WHERE tenant_id=$1::uuid AND id=$2::int AND is_active=TRUE
          FOR UPDATE`,
        req.tenantId,
        id,
      );
      if (!catalog[0]) return [];
      const reopenResolvedRecovery = async (tableKind, recovery) => {
        if (recovery.status !== 'RESOLVED') return;
        const tableName = tableKind === 'ward'
          ? 'pharmacy_ward_allocation_authority_recovery'
          : 'pharmacy_inventory_authority_recovery_worklist';
        const targetBefore = JSON.parse(JSON.stringify(
          recovery,
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        ));
        const targetIdentity = tableKind === 'ward'
          ? {
              recovery_id: String(recovery.id),
              allocation_id: String(recovery.allocation_id),
              reason_code: recovery.reason_code,
            }
          : {
              recovery_id: String(recovery.id),
              entity_type: recovery.entity_type,
              entity_id: String(recovery.entity_id),
              reason_code: recovery.reason_code,
            };
        const eventCommandSha256 = createHash('sha256')
          .update(`${removalCommandSha256}:${tableKind}:${recovery.id}:reopen`)
          .digest('hex');
        await tx.$queryRawUnsafe(
          `SELECT
             set_config('app.pharmacy_recovery_actor_uid', $1, TRUE) AS actor_uid,
             set_config('app.pharmacy_recovery_request_id', $2, TRUE) AS request_id,
             set_config('app.pharmacy_recovery_command_key_sha256', $3, TRUE) AS command_sha,
             set_config('app.pharmacy_recovery_request_sha256', $4, TRUE) AS request_sha,
             set_config('app.pharmacy_recovery_request_payload', $5, TRUE) AS request_payload,
             set_config('app.pharmacy_recovery_resolution_payload', $6, TRUE) AS resolution_payload,
             set_config('app.pharmacy_recovery_target_identity', $7, TRUE) AS target_identity,
             set_config('app.pharmacy_recovery_target_before', $8, TRUE) AS target_before,
             set_config('app.pharmacy_recovery_target_after', $9, TRUE) AS target_after`,
          String(req.user?.uid || ''),
          String(removalCommandKey || '').slice(0, 200),
          eventCommandSha256,
          removalRequestSha256,
          JSON.stringify(removalRequestPayload),
          JSON.stringify({
            action: 'REOPEN_CATALOG_AUTHORITY_RECOVERY',
            catalog_id: id,
            recovery_id: String(recovery.id),
            recovery_table: tableKind,
          }),
          JSON.stringify(targetIdentity),
          JSON.stringify(targetBefore),
          JSON.stringify({ captured_by: 'recovery_event_trigger_new_row' }),
        );
        const reopened = await tx.$queryRawUnsafe(
          `UPDATE ${tableName}
              SET status='OPEN', resolved_by=NULL, resolved_at=NULL,
                  resolution_note=NULL, updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='RESOLVED'
            RETURNING to_jsonb(${tableName}) AS target_after`,
          req.tenantId,
          String(recovery.id),
        );
        if (!reopened.length) {
          throw AppError.conflict(
            'Catalog authority recovery changed during deactivation',
            'PHARMACY_RECOVERY_STATE_CHANGED',
          );
        }
        if (!reopened[0].target_after?.updated_at) {
          throw AppError.conflict(
            'Catalog authority recovery returned incomplete receipt evidence',
            'PHARMACY_RECOVERY_RECEIPT_INCOMPLETE',
          );
        }
        reopenedRecoveries.push({ table: tableKind, recovery_id: String(recovery.id) });
      };
      const affectedItems = await tx.$queryRawUnsafe(
        `SELECT id, facility_id, status, metadata
           FROM pharmacy_inventory_items
          WHERE tenant_id=$1::uuid AND catalog_id=$2::int AND status='active'
          ORDER BY id
          FOR UPDATE`,
        req.tenantId,
        id,
      );
      for (const item of affectedItems) {
        const itemRecoveries = await tx.$queryRawUnsafe(
          `INSERT INTO pharmacy_inventory_authority_recovery_worklist
             (tenant_id, entity_type, entity_id, inventory_item_id, facility_id,
              catalog_id, reason_code, authority_snapshot)
           VALUES ($1::uuid, 'inventory_item', $2::int, $2::int, $3::int,
                   $4::int, 'CATALOG_DEACTIVATED', $5::jsonb)
           ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO UPDATE
             SET status=pharmacy_inventory_authority_recovery_worklist.status,
                 authority_snapshot=EXCLUDED.authority_snapshot,
                 inventory_item_id=EXCLUDED.inventory_item_id,
                 facility_id=EXCLUDED.facility_id, catalog_id=EXCLUDED.catalog_id,
                 updated_at=NOW()
            RETURNING id, entity_type, entity_id, inventory_item_id, facility_id,
                      catalog_id, reason_code, authority_snapshot, status,
                      resolved_by, resolved_at, resolution_note, created_at, updated_at`,
          req.tenantId,
          Number(item.id),
          Number(item.facility_id),
          id,
          JSON.stringify({
            prior_status: item.status,
            catalog_id: id,
            deactivated_by: req.user?.uid || null,
          }),
        );
        for (const recovery of itemRecoveries) {
          await reopenResolvedRecovery('generic', recovery);
        }
        const batchRecoveries = await tx.$queryRawUnsafe(
          `INSERT INTO pharmacy_inventory_authority_recovery_worklist
             (tenant_id, entity_type, entity_id, inventory_item_id, facility_id,
              catalog_id, reason_code, authority_snapshot)
           SELECT batch.tenant_id, 'inventory_batch', batch.id, batch.inventory_item_id,
                  batch.facility_id, $3::int, 'CATALOG_DEACTIVATED',
                  jsonb_build_object(
                    'prior_status', batch.status,
                    'catalog_id', $3::int,
                    'deactivated_by', $4::uuid
                  )
             FROM pharmacy_inventory_batches batch
            WHERE batch.tenant_id=$1::uuid
              AND batch.inventory_item_id=$2::int
              AND batch.status IN ('in_stock', 'reserved')
           ON CONFLICT (tenant_id, entity_type, entity_id, reason_code) DO UPDATE
             SET status=pharmacy_inventory_authority_recovery_worklist.status,
                 authority_snapshot=EXCLUDED.authority_snapshot,
                 inventory_item_id=EXCLUDED.inventory_item_id,
                 facility_id=EXCLUDED.facility_id, catalog_id=EXCLUDED.catalog_id,
                 updated_at=NOW()
            RETURNING id, entity_type, entity_id, inventory_item_id, facility_id,
                      catalog_id, reason_code, authority_snapshot, status,
                      resolved_by, resolved_at, resolution_note, created_at, updated_at`,
          req.tenantId,
          Number(item.id),
          id,
          req.user?.uid || null,
        );
        for (const recovery of batchRecoveries) {
          await reopenResolvedRecovery('generic', recovery);
        }
      }
      await tx.$executeRawUnsafe(
        `UPDATE ward_indent_inventory_allocations allocation
            SET status='released', released_by=$3::uuid, released_at=NOW(),
                release_reason='catalog_deactivated_before_issue', updated_at=NOW()
           FROM pharmacy_inventory_items item
          WHERE allocation.tenant_id=$1::uuid
            AND item.tenant_id=allocation.tenant_id
            AND item.id=allocation.inventory_item_id
            AND item.catalog_id=$2::int
            AND allocation.status IN ('reserved','partially_issued')
            AND allocation.issued_quantity=0`,
        req.tenantId,
        id,
        req.user?.uid || null,
      );
      const wardRecoveries = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_ward_allocation_authority_recovery
           (tenant_id, allocation_id, ward_indent_id, ward_indent_item_id,
            inventory_item_id, inventory_batch_id, facility_id, catalog_id,
            reason_code, authority_snapshot)
         SELECT allocation.tenant_id, allocation.id, allocation.ward_indent_id,
                allocation.ward_indent_item_id, allocation.inventory_item_id,
                allocation.inventory_batch_id, batch.facility_id, $2::int,
                'CATALOG_DEACTIVATED_ISSUED_WARD_ALLOCATION',
                jsonb_build_object(
                  'ward_indent_id', allocation.ward_indent_id,
                  'ward_indent_item_id', allocation.ward_indent_item_id,
                  'allocation_id', allocation.id::text,
                  'inventory_batch_id', allocation.inventory_batch_id,
                  'allocation_status', allocation.status,
                  'issued_quantity', allocation.issued_quantity,
                  'deactivated_by', $3::uuid
                )
           FROM ward_indent_inventory_allocations allocation
           JOIN pharmacy_inventory_items item
             ON item.tenant_id=allocation.tenant_id
            AND item.id=allocation.inventory_item_id
            AND item.catalog_id=$2::int
           JOIN pharmacy_inventory_batches batch
             ON batch.tenant_id=allocation.tenant_id
            AND batch.id=allocation.inventory_batch_id
            AND batch.inventory_item_id=allocation.inventory_item_id
          WHERE allocation.tenant_id=$1::uuid
            AND allocation.status IN ('partially_issued','issued')
            AND allocation.issued_quantity>0
         ON CONFLICT (tenant_id, allocation_id, reason_code) DO UPDATE
           SET status=pharmacy_ward_allocation_authority_recovery.status,
               authority_snapshot=EXCLUDED.authority_snapshot,
               inventory_item_id=EXCLUDED.inventory_item_id,
               inventory_batch_id=EXCLUDED.inventory_batch_id,
               ward_indent_id=EXCLUDED.ward_indent_id,
               ward_indent_item_id=EXCLUDED.ward_indent_item_id,
               facility_id=EXCLUDED.facility_id, catalog_id=EXCLUDED.catalog_id,
               updated_at=NOW()
          RETURNING id, allocation_id, ward_indent_id, ward_indent_item_id,
                    inventory_item_id, inventory_batch_id, facility_id, catalog_id,
                    reason_code, authority_snapshot, status, resolved_by,
                    resolved_at, resolution_note, created_at, updated_at`,
        req.tenantId,
        id,
        req.user?.uid || null,
      );
      for (const recovery of wardRecoveries) {
        await reopenResolvedRecovery('ward', recovery);
      }
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_items
            SET status='paused',
                metadata=COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'inventory_authority_recovery_required', TRUE,
                    'inventory_authority_quarantined_by', 'catalog_deactivation'
                  ),
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND catalog_id=$2::int AND status='active'`,
        req.tenantId,
        id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_batches batch
            SET status='quarantined',
                metadata=COALESCE(batch.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'inventory_authority_recovery_required', TRUE,
                    'inventory_authority_quarantined_by', 'catalog_deactivation'
                  ),
                updated_at=NOW()
           FROM pharmacy_inventory_items item
          WHERE batch.tenant_id=$1::uuid
            AND item.tenant_id=batch.tenant_id
            AND item.id=batch.inventory_item_id
            AND item.catalog_id=$2::int
            AND batch.status IN ('in_stock', 'reserved')`,
        req.tenantId,
        id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_orders po
            SET clinical_verification_status='pending',
                clinically_verified_by=NULL,
                clinically_verified_at=NULL,
                clinically_verified_order_version=NULL,
                clinical_verification_items_sha256=NULL,
                clinical_verification_catalog_sha256=NULL,
                clinical_verification_safety_version=NULL,
                clinical_verification_kb_version=NULL,
                clinical_verification_ruleset_version=NULL,
                inventory_authority_version=inventory_authority_version+1,
                updated_at=NOW()
          WHERE po.tenant_id=$1::uuid
            AND po.status NOT IN ('DELIVERED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED')
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(po.items_list, '[]'::jsonb)) line(value)
               WHERE NULLIF(line.value->>'catalog_id', '')::int=$2::int
            )`,
        req.tenantId,
        id,
      );
      return tx.$queryRawUnsafe(
        `UPDATE pharmacy_catalog
            SET is_active=FALSE, is_available=FALSE, in_stock=FALSE, updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND is_active=TRUE
          RETURNING id, name, generic_name, category, updated_at`,
        req.tenantId,
        id,
      );
    });

    if (!result?.length) {
      return error(res, 'Medicine not found in active formulary', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      ...result[0],
      recovery_reopen_receipts: reopenedRecoveries,
    }, 'Medicine removed from formulary');
  } catch (err) {
    logger.error('Remove pharmacy catalog error:', err);
    relayAppError(res, err, 'Failed to remove medicine');
  }
};
