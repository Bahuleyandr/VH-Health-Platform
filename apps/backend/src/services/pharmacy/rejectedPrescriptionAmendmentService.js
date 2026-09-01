import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import { stripHtml } from '../../utils/sanitize.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { isGateEnabled } from '../staff/credentialingService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  clinicalOrderItemsSha256,
  lockPharmacyCatalogAuthorityTx,
} from './pharmacistVerificationService.js';
import {
  loadPharmacyOrderCommandReceiptTx,
  pharmacyCommandRequestSha256,
  storePharmacyOrderCommandReceiptTx,
} from './pharmacyOrderCommandReceiptService.js';

const ACTION = 'amend_rejected_rx';
const CONTROLLED_SUBSTANCE_GATE = 'CONTROLLED_SUBSTANCE_REQUIRE_PRESCRIBE_PRIVILEGE';
const COMMAND_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const PRESCRIBER_ROLES = new Set([
  'DOCTOR',
  'DUTY_DOCTOR',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
]);
const COVERING_AUTHORITY_ROLES = new Set(['CMO', 'MEDICAL_SUPERINTENDENT']);
const TOP_LEVEL_KEYS = new Set([
  'expected_prescription_revision',
  'expected_order_version',
  'medications',
  'amendment_reason',
  'authorization_reason',
]);
const MEDICATION_KEYS = new Set([
  'catalog_id',
  'ordered_quantity',
  'dose',
  'frequency',
  'route',
  'duration',
  'instructions',
]);
const CONTROLLED_SUBSTANCE_RE =
  /\b(controlled|narcotic|opioid|opiate|psychotropic|ndps|schedule\s*(?:h1|x|ii|iii|iv|v|2|3|4|5))\b/i;

function positiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'PRESCRIPTION_AMENDMENT_INVALID_REQUEST');
  }
  return parsed;
}

function boundedText(value, field, { min = 0, max = 500, required = false } = {}) {
  const normalized = stripHtml(String(value ?? '')).trim();
  if ((required && normalized.length < min)
    || (!required && normalized.length > 0 && normalized.length < min)
    || normalized.length > max) {
    throw AppError.badRequest(
      `${field} must contain ${min} to ${max} characters`,
      'PRESCRIPTION_AMENDMENT_INVALID_REQUEST',
    );
  }
  return normalized || null;
}

function rejectUnknownKeys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${context} must be an object`, 'PRESCRIPTION_AMENDMENT_INVALID_REQUEST');
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw AppError.badRequest(
      `${context} contains unsupported fields`,
      'PRESCRIPTION_AMENDMENT_INVALID_REQUEST',
      { unsupported_fields: unknown.sort() },
    );
  }
}

export function normalizeRejectedPrescriptionAmendment(body = {}) {
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, 'request body');
  if (!Array.isArray(body.medications) || body.medications.length < 1 || body.medications.length > 100) {
    throw AppError.badRequest(
      'medications must contain 1 to 100 exact catalog lines',
      'PRESCRIPTION_AMENDMENT_INVALID_REQUEST',
    );
  }
  const medications = body.medications.map((line, index) => {
    rejectUnknownKeys(line, MEDICATION_KEYS, `medications[${index}]`);
    return {
      catalog_id: positiveInt(line.catalog_id, `medications[${index}].catalog_id`),
      ordered_quantity: positiveInt(
        line.ordered_quantity,
        `medications[${index}].ordered_quantity`,
      ),
      dose: boundedText(line.dose, `medications[${index}].dose`, { max: 120 }),
      frequency: boundedText(line.frequency, `medications[${index}].frequency`, { max: 120 }),
      route: boundedText(line.route, `medications[${index}].route`, { max: 80 }),
      duration: boundedText(line.duration, `medications[${index}].duration`, { max: 120 }),
      instructions: boundedText(line.instructions, `medications[${index}].instructions`, { max: 1000 }),
    };
  });
  return {
    expected_prescription_revision: positiveInt(
      body.expected_prescription_revision,
      'expected_prescription_revision',
    ),
    expected_order_version: positiveInt(body.expected_order_version, 'expected_order_version'),
    medications,
    amendment_reason: boundedText(body.amendment_reason, 'amendment_reason', {
      min: 10,
      max: 500,
      required: true,
    }),
    authorization_reason: boundedText(body.authorization_reason, 'authorization_reason', {
      min: 10,
      max: 500,
    }),
  };
}

export function createRejectedPrescriptionAmendmentCommandIdentity({
  tenantId,
  actorUid,
  prescriptionId,
  idempotencyKey,
}) {
  const key = String(idempotencyKey || '').trim();
  if (!COMMAND_KEY_RE.test(key) || !actorUid) {
    throw AppError.badRequest(
      'An authenticated actor and valid Idempotency-Key are required',
      'PRESCRIPTION_AMENDMENT_COMMAND_IDENTITY_REQUIRED',
    );
  }
  return createHash('sha256')
    .update(`${tenantId}:${actorUid}:amend-rejected-prescription:${prescriptionId}:${key}`)
    .digest('hex');
}

function money(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : 0;
}

function hasProgressedLineEvidence(line) {
  if (!line || typeof line !== 'object') return false;
  const positiveFields = [
    'dispensed_quantity',
    'inventory_dispensed_quantity',
    'allocated_quantity',
    'issued_quantity',
    'billable_dispensed_quantity',
  ];
  if (positiveFields.some((field) => Number(line[field] || 0) > 0)) return true;
  const identityFields = [
    'allocation_id',
    'inventory_allocation_id',
    'movement_id',
    'inventory_movement_id',
    'inventory_batch_id',
    'batch_id',
  ];
  if (identityFields.some((field) => line[field] != null)) return true;
  return ['allocations', 'batch_allocations', 'inventory_movements']
    .some((field) => Array.isArray(line[field]) && line[field].length > 0);
}

function assertNoProgressedOrderEvidence(order) {
  const items = Array.isArray(order.items_list) ? order.items_list : [];
  const paymentStatus = String(order.payment_status || 'pending').toLowerCase();
  if (
    order.dispensed_by != null
    || order.dispensed_at != null
    || order.dispensed_medications != null
    || order.partial_dispense === true
    || Number(order.amount_collected || 0) > 0
    || !['pending', 'unpaid'].includes(paymentStatus)
    || items.some(hasProgressedLineEvidence)
  ) {
    throw AppError.conflict(
      'The rejected order already has dispensing, allocation, or financial progress',
      'PRESCRIPTION_AMENDMENT_ORDER_ALREADY_PROGRESSED',
    );
  }
}

async function assertNoAuthoritativeOrderProgressTx(tx, { tenantId, orderId }) {
  const checks = [
    () => tx.$queryRawUnsafe(
      `SELECT id
         FROM pharmacy_stock_movements
        WHERE tenant_id=$1::uuid
          AND (
            metadata->>'order_id'=$2::text
            OR (reference_type IN ('pharmacy_order_dispense', 'dispense_substitution')
                AND reference_id LIKE $2::text || ':%')
          )
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      String(orderId),
    ),
    () => tx.$queryRawUnsafe(
      `SELECT item.id
         FROM billing_invoice_items item
        WHERE item.tenant_id=$1::uuid
          AND item.source_ref_type='pharmacy_order'
          AND item.source_ref_id=$2::bigint
        ORDER BY item.id LIMIT 1 FOR KEY SHARE OF item`,
      tenantId,
      orderId,
    ),
    () => tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_funding_decision_events
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      orderId,
    ),
    () => tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_funding_commands
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      orderId,
    ),
    () => tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_payment_allocations
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      orderId,
    ),
    () => tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_cap_reservations
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      orderId,
    ),
    () => tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_cap_reservation_events
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      orderId,
    ),
    () => tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_order_history
        WHERE tenant_id=$1::uuid AND order_id=$2::int
          AND (
            UPPER(COALESCE(from_status, ''))=ANY($3::text[])
            OR UPPER(COALESCE(to_status, ''))=ANY($3::text[])
          )
        ORDER BY id LIMIT 1 FOR KEY SHARE`,
      tenantId,
      orderId,
      ['PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'DELIVERED'],
    ),
    () => tx.$queryRawUnsafe(
      `SELECT register.id
         FROM pharmacy_schedule_register register
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id=register.tenant_id
          AND movement.id=register.reference_movement_id
        WHERE register.tenant_id=$1::uuid
          AND movement.metadata->>'order_id'=$2::text
        ORDER BY register.id LIMIT 1
        FOR KEY SHARE OF register, movement`,
      tenantId,
      String(orderId),
    ),
  ];
  for (const check of checks) {
    const rows = await check();
    if (rows.length > 0) {
      throw AppError.conflict(
        'The rejected order has authoritative inventory, billing, funding, or fulfilment progress',
        'PRESCRIPTION_AMENDMENT_ORDER_ALREADY_PROGRESSED',
      );
    }
  }
}

async function lockActiveControlledPrescribePrivilegeTx(tx, { tenantId, actorUid }) {
  const catalogRows = await tx.$queryRawUnsafe(
    `SELECT credential.id, credential.valid_from, credential.valid_until
       FROM staff_credentials credential
       JOIN privilege_catalog privilege
         ON privilege.tenant_id=credential.tenant_id
        AND privilege.id=credential.privilege_catalog_id
        AND privilege.privilege_key='controlled_substance_prescribe'
        AND privilege.status='active'
      WHERE credential.tenant_id=$1::uuid
        AND credential.staff_uid=$2::uuid
        AND credential.credential_type='privilege'
        AND credential.status='active'
        AND credential.approved_by IS NOT NULL
        AND credential.approved_at IS NOT NULL
        AND credential.renewal_status='current'
        AND (credential.valid_from IS NULL OR credential.valid_from <= CURRENT_DATE)
        AND (credential.valid_until IS NULL OR credential.valid_until >= CURRENT_DATE)
      ORDER BY credential.id
      LIMIT 1
      FOR UPDATE OF credential, privilege`,
    tenantId,
    actorUid,
  );
  if (catalogRows.length) return Number(catalogRows[0].id);

  const legacyRows = await tx.$queryRawUnsafe(
    `SELECT credential.id, credential.valid_from, credential.valid_until
       FROM staff_credentials credential
      WHERE credential.tenant_id=$1::uuid
        AND credential.staff_uid=$2::uuid
        AND credential.credential_type='privilege'
        AND credential.privilege_catalog_id IS NULL
        AND credential.status='active'
        AND credential.approved_by IS NOT NULL
        AND credential.approved_at IS NOT NULL
        AND credential.renewal_status='current'
        AND (credential.valid_from IS NULL OR credential.valid_from <= CURRENT_DATE)
        AND (credential.valid_until IS NULL OR credential.valid_until >= CURRENT_DATE)
        AND (
          lower(regexp_replace(credential.name, '[^a-zA-Z0-9]+', '_', 'g'))
            ='controlled_substance_prescribe'
          OR UPPER(credential.name)=UPPER('controlled_substance_prescribe')
        )
      ORDER BY credential.id
      LIMIT 1
      FOR UPDATE OF credential`,
    tenantId,
    actorUid,
  );
  if (!legacyRows.length) {
    throw AppError.forbidden(
      'The amendment actor does not hold a current controlled-substance prescribing privilege',
      'CLINICAL_PRIVILEGE_REQUIRED',
      { gate: 'controlled_substance_erx_amendment', privilege_key: 'controlled_substance_prescribe' },
    );
  }
  return Number(legacyRows[0].id);
}

async function lockCoveringClinicalAuthorityTx(tx, {
  tenantId,
  patientUid,
  actorId,
  actorUid,
  actorRole,
}) {
  const memberships = await tx.$queryRawUnsafe(
    `SELECT member.id, member.care_team_id, member.relationship_kind,
            member.access_scope, team.team_kind, team.appointment_id, team.admission_id
       FROM care_team_members member
       JOIN care_teams team
         ON team.tenant_id=member.tenant_id
        AND team.id=member.care_team_id
        AND team.patient_uid=member.patient_uid
      WHERE member.tenant_id=$1::uuid
        AND member.patient_uid=$2::uuid
        AND (member.staff_uid=$3::uuid OR member.staff_id=$4::int)
        AND member.status='active'
        AND team.status='active'
        AND member.active_from <= clock_timestamp()
        AND (member.active_until IS NULL OR member.active_until >= clock_timestamp())
      ORDER BY member.id DESC
      FOR UPDATE OF member, team`,
    tenantId,
    patientUid,
    actorUid,
    actorId,
  );
  for (const membership of memberships) {
    const appointmentId = membership.appointment_id == null
      ? null
      : Number(membership.appointment_id);
    const admissionId = membership.admission_id == null ? null : Number(membership.admission_id);
    if (appointmentId == null && admissionId == null
      && String(membership.team_kind || '').trim().toLowerCase() === 'longitudinal') {
      return {
        source: 'care_team',
        id: Number(membership.id),
        care_team_id: Number(membership.care_team_id),
        relationship_kind: membership.relationship_kind || null,
        access_scope: membership.access_scope || {},
        break_glass_reason: null,
      };
    }
    if (appointmentId != null && admissionId == null) {
      const appointments = await tx.$queryRawUnsafe(
        `SELECT appointment.id
           FROM appointments appointment
           JOIN users appointment_patient
             ON appointment_patient.tenant_id=appointment.tenant_id
            AND appointment_patient.id=appointment.patient_id
          WHERE appointment.tenant_id=$1::uuid
            AND appointment.id=$2::int
            AND appointment_patient.uid=$3::uuid
            AND UPPER(BTRIM(COALESCE(appointment.status, ''))) NOT IN (
              'CANCELLED', 'NO_SHOW', 'RESCHEDULED'
            )
            AND appointment.appointment_date >= (CURRENT_DATE - INTERVAL '30 days')
            AND appointment.appointment_date <= (CURRENT_DATE + INTERVAL '30 days')
          LIMIT 1
          FOR UPDATE OF appointment, appointment_patient`,
        tenantId,
        appointmentId,
        patientUid,
      );
      if (appointments.length) {
        return {
          source: 'care_team',
          id: Number(membership.id),
          care_team_id: Number(membership.care_team_id),
          relationship_kind: membership.relationship_kind || null,
          access_scope: membership.access_scope || {},
          break_glass_reason: null,
        };
      }
    }
    if (admissionId != null && appointmentId == null) {
      const admissions = await tx.$queryRawUnsafe(
        `SELECT admission.id
           FROM admissions admission
          WHERE admission.tenant_id=$1::uuid
            AND admission.id=$2::int
            AND admission.patient_uid=$3::uuid
            AND LOWER(BTRIM(COALESCE(admission.status, ''))) IN ('admitted', 'transferred')
          LIMIT 1
          FOR UPDATE OF admission`,
        tenantId,
        admissionId,
        patientUid,
      );
      if (admissions.length) {
        return {
          source: 'care_team',
          id: Number(membership.id),
          care_team_id: Number(membership.care_team_id),
          relationship_kind: membership.relationship_kind || null,
          access_scope: membership.access_scope || {},
          break_glass_reason: null,
        };
      }
    }
  }

  const breakGlassRows = await tx.$queryRawUnsafe(
    `SELECT id, reason
       FROM patient_access_break_glass
      WHERE tenant_id=$1::uuid
        AND patient_uid=$2::uuid
        AND actor_uid=$3::uuid
        AND UPPER(BTRIM(COALESCE(actor_role, '')))=$4
        AND status='active'
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND length(BTRIM(reason)) > 0
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      FOR UPDATE OF patient_access_break_glass`,
    tenantId,
    patientUid,
    actorUid,
    actorRole,
  );
  if (!breakGlassRows.length) return null;
  return {
    source: 'patient_access_break_glass',
    id: Number(breakGlassRows[0].id),
    care_team_id: null,
    relationship_kind: null,
    access_scope: null,
    break_glass_reason: breakGlassRows[0].reason,
  };
}

function canonicalMedicationProjection(requestedLines, catalogRows, amendment) {
  const byId = new Map(catalogRows.map((row) => [Number(row.catalog_id), row]));
  if (byId.size !== new Set(requestedLines.map((line) => line.catalog_id)).size) {
    throw AppError.conflict(
      'One or more medication catalog identities are unavailable or inactive',
      'PRESCRIPTION_AMENDMENT_CATALOG_CHANGED',
    );
  }
  let totalAmount = 0;
  const medications = [];
  const itemsList = requestedLines.map((requested, index) => {
    const catalog = byId.get(requested.catalog_id);
    if (!catalog) {
      throw AppError.conflict(
        'One or more medication catalog identities are unavailable or inactive',
        'PRESCRIPTION_AMENDMENT_CATALOG_CHANGED',
        { prescription_line_index: index, catalog_id: requested.catalog_id },
      );
    }
    const catalogRoute = String(catalog.route || '').trim();
    if (requested.route && catalogRoute
      && requested.route.toLowerCase() !== catalogRoute.toLowerCase()) {
      throw AppError.conflict(
        'The requested route conflicts with the authoritative catalog route',
        'PRESCRIPTION_AMENDMENT_CATALOG_CHANGED',
        { prescription_line_index: index, catalog_id: requested.catalog_id },
      );
    }
    const unitPrice = money(catalog.unit_price ?? catalog.price);
    const lineTotal = money(unitPrice * requested.ordered_quantity);
    totalAmount = money(totalAmount + lineTotal);
    const shared = {
      prescription_line_index: index,
      catalog_id: requested.catalog_id,
      original_catalog_id: requested.catalog_id,
      name: catalog.name,
      medication_name: catalog.name,
      generic_name: catalog.generic_name || null,
      composition_id: catalog.composition_id == null ? null : Number(catalog.composition_id),
      active_ingredients: catalog.active_ingredients || null,
      strength: catalog.strength || null,
      form: catalog.form || null,
      route: requested.route || catalogRoute || null,
      dose: requested.dose,
      frequency: requested.frequency,
      duration: requested.duration,
      instructions: requested.instructions,
      ordered_quantity: requested.ordered_quantity,
      qty: requested.ordered_quantity,
      prescribed_qty: requested.ordered_quantity,
      fulfilment_generation: amendment.fulfilmentGeneration,
      dispensed_quantity: 0,
      remaining_quantity: requested.ordered_quantity,
      fulfilment_status: 'pending',
      amendment_state: 'pending_reverification',
      amended_by: amendment.actorUid,
      amended_at: amendment.amendedAt,
    };
    medications.push({ ...shared });
    return {
      ...shared,
      order_line_index: index,
      prescription_fulfilment_generation: amendment.fulfilmentGeneration,
      prescription_dispensed_baseline: 0,
      dispensed_quantity: 0,
      inventory_dispensed_quantity: 0,
      quantity_source: 'prescriber_amendment',
      quantity_needs_confirmation: false,
      price: unitPrice,
      line_total: lineTotal,
    };
  });
  return { medications, itemsList, totalAmount };
}

function controlledMedicationSelected(catalogRows, inventoryRows) {
  if (inventoryRows.some((row) => row.is_narcotic === true
    || ['H', 'H1', 'X', 'NDPS'].includes(String(row.schedule_class || '').toUpperCase()))) {
    return true;
  }
  return catalogRows.some((row) => CONTROLLED_SUBSTANCE_RE.test([
    row.name,
    row.generic_name,
    row.category,
    row.description,
  ].filter(Boolean).join(' ')));
}

function assertRejectedOrderState(order, expectedOrderVersion) {
  if (order.authority_origin !== 'e_prescription') {
    throw AppError.conflict(
      'Only e-prescription-origin pharmacy orders can be amended through this command',
      'PRESCRIPTION_AMENDMENT_WRONG_ORIGIN',
    );
  }
  if (order.status !== 'ON_HOLD' || order.clinical_verification_status !== 'rejected') {
    throw AppError.conflict(
      'Only an ON_HOLD order with an exact rejected verification may be amended',
      'PRESCRIPTION_AMENDMENT_WRONG_STATE',
      { status: order.status, clinical_verification_status: order.clinical_verification_status },
    );
  }
  if (Number(order.inventory_authority_version) !== expectedOrderVersion
    || Number(order.clinically_verified_order_version) !== expectedOrderVersion) {
    throw AppError.conflict(
      'The rejected order version changed or already has an amendment pending verification',
      'PRESCRIPTION_AMENDMENT_STALE_ORDER_VERSION',
    );
  }
  const rejectedItemsSha256 = clinicalOrderItemsSha256(order.items_list);
  if (!order.clinical_verification_items_sha256
    || rejectedItemsSha256 !== order.clinical_verification_items_sha256) {
    throw AppError.conflict(
      'The rejected order no longer matches its immutable verification evidence',
      'PRESCRIPTION_AMENDMENT_REJECTION_EVIDENCE_CHANGED',
    );
  }
  return rejectedItemsSha256;
}

export async function amendRejectedPrescription({
  prescriptionId,
  tenantId,
  actorUid,
  actorRole,
  idempotencyKey,
  body,
}) {
  const tid = requireTenantId(tenantId);
  const rxId = positiveInt(prescriptionId, 'prescription id');
  const normalized = normalizeRejectedPrescriptionAmendment(body);
  const commandKeySha256 = createRejectedPrescriptionAmendmentCommandIdentity({
    tenantId: tid,
    actorUid,
    prescriptionId: rxId,
    idempotencyKey,
  });

  const outcome = await setTenantTx(tid, async (tx) => {
    const preflight = await tx.$queryRawUnsafe(
      `SELECT id, patient_id, patient_uid, pharmacy_order_id
         FROM e_prescriptions
        WHERE tenant_id=$1::uuid AND id=$2::int
        LIMIT 1`,
      tid,
      rxId,
    );
    if (!preflight.length) {
      throw AppError.notFound('Prescription not found', 'PRESCRIPTION_AMENDMENT_NOT_FOUND');
    }
    const target = preflight[0];
    if (!target.pharmacy_order_id || !target.patient_id || !target.patient_uid) {
      throw AppError.conflict(
        'Prescription has no complete patient-linked pharmacy order authority',
        'PRESCRIPTION_AMENDMENT_LINKAGE_REQUIRED',
      );
    }
    const orderId = Number(target.pharmacy_order_id);
    const requestSha256 = pharmacyCommandRequestSha256({
      prescription_id: rxId,
      pharmacy_order_id: orderId,
      ...normalized,
    });

    await lockTenantPatientMergeStability(tx, tid);
    await lockPharmacyCatalogAuthorityTx(tx, tid);
    const normalizedTokenRole = String(actorRole || '').toUpperCase();
    const actors = await tx.$queryRawUnsafe(
      `SELECT id, uid, role, name
         FROM users
        WHERE tenant_id=$1::uuid AND uid=$2::uuid
          AND role=ANY($3::text[])
          AND is_active=TRUE AND status='active'
          AND is_deleted=FALSE AND merged_into_uid IS NULL
        LIMIT 1
        FOR UPDATE`,
      tid,
      String(actorUid),
      [...PRESCRIBER_ROLES],
    );
    const actor = actors[0];
    const canonicalRole = String(actor?.role || '').toUpperCase();
    if (!actor || !PRESCRIBER_ROLES.has(canonicalRole) || canonicalRole !== normalizedTokenRole) {
      throw AppError.forbidden(
        'The authenticated actor has no active same-tenant prescribing authority',
        'PRESCRIPTION_AMENDMENT_ACTOR_AUTHORITY_REQUIRED',
      );
    }

    const receipt = await loadPharmacyOrderCommandReceiptTx(tx, {
      tenantId: tid,
      orderId,
      action: ACTION,
      commandKeySha256,
      requestSha256,
    });
    if (receipt) return { replay: true, result: receipt.payload };

    const orders = await tx.$queryRawUnsafe(
      `SELECT po.id, po.patient_id, po.facility_id, po.order_number, po.status,
              po.authority_origin, po.items_list, po.total_amount, po.payment_status,
              po.amount_collected, po.partial_dispense, po.dispensed_by, po.dispensed_at,
              po.dispensed_medications, po.inventory_authority_version,
              po.clinical_verification_status, po.clinically_verified_order_version,
              po.clinical_verification_items_sha256, po.clinical_verification_catalog_sha256,
              po.clinical_verification_active_therapy_sha256,
              po.clinical_verification_safety_version, po.clinical_verification_kb_version,
              po.clinical_verification_ruleset_version, po.clinically_verified_by,
              po.clinically_verified_at, po.clinical_verification_notes,
              po.clinical_verification_findings, po.prescribed_by,
              f.status AS facility_status
         FROM pharmacy_orders po
         JOIN facilities f ON f.tenant_id=po.tenant_id AND f.id=po.facility_id
        WHERE po.tenant_id=$1::uuid AND po.id=$2::int
        LIMIT 1
        FOR UPDATE OF po, f`,
      tid,
      orderId,
    );
    if (!orders.length || orders[0].facility_status !== 'active') {
      throw AppError.conflict(
        'The linked pharmacy order facility authority is unavailable or inactive',
        'PRESCRIPTION_AMENDMENT_FACILITY_AUTHORITY_CHANGED',
      );
    }
    const order = orders[0];

    const linkedPrescriptions = await tx.$queryRawUnsafe(
      `SELECT prescription.id, prescription.patient_id, prescription.patient_uid,
              prescription.doctor_id, prescription.doctor_uid, prescription.medications,
              prescription.status, prescription.pharmacy_opted, prescription.pharmacy_order_id,
              prescription.revision, prescription.lifecycle_status, prescription.signed_at,
              prescription.signed_by, prescription.locked_at, prescription.locked_by,
              prescriber.role AS original_prescriber_role
         FROM e_prescriptions prescription
         JOIN users prescriber
           ON prescriber.tenant_id=prescription.tenant_id
          AND prescriber.id=prescription.doctor_id
          AND prescriber.uid=prescription.doctor_uid
          AND prescriber.role=ANY($3::text[])
          AND prescriber.is_deleted=FALSE
          AND prescriber.merged_into_uid IS NULL
        WHERE prescription.tenant_id=$1::uuid AND prescription.pharmacy_order_id=$2::int
        ORDER BY prescription.id
        FOR UPDATE OF prescription, prescriber`,
      tid,
      orderId,
      [...PRESCRIBER_ROLES],
    );
    if (linkedPrescriptions.length !== 1 || Number(linkedPrescriptions[0].id) !== rxId) {
      throw AppError.conflict(
        'The pharmacy order does not have exactly one authoritative linked prescription',
        'PRESCRIPTION_AMENDMENT_LINKAGE_CHANGED',
      );
    }
    const prescription = linkedPrescriptions[0];
    const patients = await tx.$queryRawUnsafe(
      `SELECT p.id, p.uid
         FROM users p
        WHERE p.tenant_id=$1::uuid AND p.id=$2::int AND p.uid=$3::uuid
          AND p.role='PATIENT' AND p.is_active=TRUE AND p.status='active'
          AND p.is_deleted=FALSE AND p.merged_into_uid IS NULL
        LIMIT 1
        FOR UPDATE OF p`,
      tid,
      Number(target.patient_id),
      String(target.patient_uid),
    );
    if (!patients.length) {
      throw AppError.conflict(
        'The prescription patient authority is inactive, merged, or changed',
        'PRESCRIPTION_AMENDMENT_PATIENT_AUTHORITY_CHANGED',
      );
    }
    if (Number(prescription.patient_id) !== Number(patients[0].id)
      || String(prescription.patient_uid) !== String(patients[0].uid)
      || Number(order.patient_id) !== Number(patients[0].id)
      || Number(prescription.revision) !== normalized.expected_prescription_revision
      || prescription.status !== 'pharmacy_linked'
      || prescription.pharmacy_opted !== true
      || prescription.lifecycle_status !== 'signed'
      || !prescription.signed_at
      || !prescription.locked_at
      || !prescription.doctor_uid
      || !PRESCRIBER_ROLES.has(String(prescription.original_prescriber_role || '').toUpperCase())
      || String(prescription.signed_by || '') !== String(prescription.doctor_uid)
      || String(prescription.locked_by || '') !== String(prescription.doctor_uid)
      || String(order.prescribed_by || '') !== String(prescription.doctor_uid)) {
      throw AppError.conflict(
        'The prescription revision, lifecycle, prescriber, signature, patient, or pharmacy linkage changed',
        'PRESCRIPTION_AMENDMENT_STALE_PRESCRIPTION',
      );
    }

    const rejectedItemsSha256 = assertRejectedOrderState(
      order,
      normalized.expected_order_version,
    );
    assertNoProgressedOrderEvidence(order);
    await assertNoAuthoritativeOrderProgressTx(tx, { tenantId: tid, orderId });

    const originalPrescriber = String(prescription.doctor_uid || '') === String(actor.uid);
    let authorizationBasis = 'original_prescriber';
    let coveringAuthorityId = null;
    let coveringAuthoritySource = null;
    let coveringAuthorityEvidence = null;
    if (!originalPrescriber) {
      if (!COVERING_AUTHORITY_ROLES.has(canonicalRole)) {
        throw AppError.forbidden(
          'Only the original prescriber or an authorized clinical leader may amend this rejection',
          'PRESCRIPTION_AMENDMENT_ACTOR_NOT_AUTHORIZED',
        );
      }
      if (!normalized.authorization_reason || normalized.authorization_reason.length < 10) {
        throw AppError.badRequest(
          'authorization_reason must contain 10 to 500 characters for covering authority',
          'PRESCRIPTION_AMENDMENT_AUTHORIZATION_REASON_REQUIRED',
        );
      }
      const coveringAuthority = await lockCoveringClinicalAuthorityTx(tx, {
        tenantId: tid,
        patientUid: String(patients[0].uid),
        actorId: Number(actor.id),
        actorUid: String(actor.uid),
        actorRole: canonicalRole,
      });
      if (!coveringAuthority) {
        throw AppError.forbidden(
          'The covering clinical leader has no active patient-specific care-team or break-glass authority',
          'PRESCRIPTION_AMENDMENT_COVERING_AUTHORITY_REQUIRED',
        );
      }
      coveringAuthorityId = coveringAuthority.id;
      coveringAuthoritySource = coveringAuthority.source;
      coveringAuthorityEvidence = coveringAuthority;
      authorizationBasis = 'same_tenant_clinical_leader';
    }

    const catalogIds = [...new Set(normalized.medications.map((line) => line.catalog_id))]
      .sort((a, b) => a - b);
    const lockedCatalogRows = await tx.$queryRawUnsafe(
      `SELECT pc.id AS catalog_id, pc.name, pc.generic_name, pc.category, pc.description,
              COALESCE(pc.unit_price, pc.price, 0) AS unit_price,
              pc.composition_id, pc.strength, pc.form, pc.route
         FROM pharmacy_catalog pc
        WHERE pc.tenant_id=$1::uuid AND pc.id=ANY($2::int[])
          AND pc.is_active=TRUE AND COALESCE(pc.is_available, TRUE)=TRUE
        ORDER BY pc.id
        FOR UPDATE OF pc`,
      tid,
      catalogIds,
    );
    const compositionIds = [...new Set(lockedCatalogRows
      .map((row) => Number(row.composition_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
    const compositionRows = compositionIds.length
      ? await tx.$queryRawUnsafe(
        `SELECT id, active_ingredients
           FROM drug_compositions
          WHERE id=ANY($1::int[])
          ORDER BY id
          FOR UPDATE OF drug_compositions`,
        compositionIds,
      )
      : [];
    if (compositionRows.length !== compositionIds.length) {
      throw AppError.conflict(
        'One or more medication compositions changed or became unavailable',
        'PRESCRIPTION_AMENDMENT_CATALOG_CHANGED',
      );
    }
    const ingredientsByComposition = new Map(compositionRows.map((row) => [
      Number(row.id),
      row.active_ingredients,
    ]));
    const catalogRows = lockedCatalogRows.map((row) => ({
      ...row,
      active_ingredients: row.composition_id == null
        ? null
        : ingredientsByComposition.get(Number(row.composition_id)) || null,
    }));
    const inventoryRows = await tx.$queryRawUnsafe(
      `SELECT catalog_id, schedule_class, is_narcotic, facility_id, status
         FROM pharmacy_inventory_items
        WHERE tenant_id=$1::uuid AND catalog_id=ANY($2::int[])
        ORDER BY id
        FOR UPDATE OF pharmacy_inventory_items`,
      tid,
      catalogIds,
    );
    let controlledPrivilegeId = null;
    if (isGateEnabled(CONTROLLED_SUBSTANCE_GATE)
      && controlledMedicationSelected(catalogRows, inventoryRows)) {
      controlledPrivilegeId = await lockActiveControlledPrescribePrivilegeTx(tx, {
        tenantId: tid,
        actorUid: actor.uid,
      });
    }

    const amendmentClockRows = await tx.$queryRawUnsafe(
      `SELECT clock_timestamp() AS amended_at`,
    );
    if (!amendmentClockRows[0]?.amended_at) {
      throw AppError.serviceUnavailable(
        'The authoritative database clock is unavailable',
        'PRESCRIPTION_AMENDMENT_CLOCK_UNAVAILABLE',
      );
    }
    const amendedAt = new Date(amendmentClockRows[0].amended_at).toISOString();
    const fulfilmentGenerations = [
      ...(Array.isArray(order.items_list) ? order.items_list : [])
        .map((line) => Number(line?.prescription_fulfilment_generation)),
      ...(Array.isArray(prescription.medications) ? prescription.medications : [])
        .map((line) => Number(line?.fulfilment_generation)),
    ].filter((value) => Number.isSafeInteger(value) && value > 0);
    const fulfilmentGeneration = fulfilmentGenerations.length
      ? Math.max(...fulfilmentGenerations)
      : 1;
    const projection = canonicalMedicationProjection(normalized.medications, catalogRows, {
      actorUid: actor.uid,
      amendedAt,
      fulfilmentGeneration,
    });
    const safety = await validatePrescriptionSafety(patients[0].id, projection.medications, {
      tenantId: tid,
      db: tx,
      excludePrescriptionId: rxId,
      excludePharmacyOrderId: orderId,
    });
    if (!safety.safe || safety.blockers?.length) {
      throw AppError.unprocessable(
        'The amended prescription still has medication-safety blockers',
        'PRESCRIPTION_AMENDMENT_SAFETY_BLOCKED',
        { blockers: safety.blockers || [] },
      );
    }

    const amendedItemsSha256 = clinicalOrderItemsSha256(projection.itemsList);
    const result = {
      prescription_id: rxId,
      pharmacy_order_id: orderId,
      status: 'ON_HOLD',
      clinical_verification_status: 'rejected',
      amendment_state: 'pending_reverification',
      prior_prescription_revision: normalized.expected_prescription_revision,
      prescription_revision: normalized.expected_prescription_revision + 1,
      prior_order_version: normalized.expected_order_version,
      order_version: normalized.expected_order_version + 1,
      rejected_items_sha256: rejectedItemsSha256,
      amended_items_sha256: amendedItemsSha256,
      authorization_basis: authorizationBasis,
      covering_authority_id: coveringAuthorityId,
      covering_authority_source: coveringAuthoritySource,
      controlled_privilege_id: controlledPrivilegeId,
      amended_by: actor.uid,
      amended_by_role: canonicalRole,
      amended_at: amendedAt,
      medications: projection.medications,
      items_list: projection.itemsList,
      total_amount: projection.totalAmount,
      safety: {
        safe: true,
        blockers: [],
        warnings: safety.warnings || [],
      },
      idempotent_replay: false,
    };

    await storePharmacyOrderCommandReceiptTx(tx, {
      tenantId: tid,
      orderId,
      action: ACTION,
      commandKeySha256,
      requestSha256,
      payload: result,
      message: 'Rejected prescription amended; fresh pharmacist verification required',
    });

    const amendedPrescriptionCount = await tx.$executeRawUnsafe(
      `UPDATE e_prescriptions
          SET medications=$1::jsonb, revision=revision+1,
              doctor_id=$2::int, doctor_uid=$3::uuid,
              signed_at=$4::timestamptz, signed_by=$3::uuid,
              locked_at=$4::timestamptz, locked_by=$3::uuid,
              updated_at=$4::timestamptz
        WHERE tenant_id=$5::uuid AND id=$6::int
          AND pharmacy_order_id=$7::int AND patient_id=$8::int AND patient_uid=$9::uuid
          AND status='pharmacy_linked' AND pharmacy_opted=TRUE
          AND revision=$10::int AND medications=$11::jsonb`,
      JSON.stringify(projection.medications),
      Number(actor.id),
      String(actor.uid),
      amendedAt,
      tid,
      rxId,
      orderId,
      Number(patients[0].id),
      String(patients[0].uid),
      normalized.expected_prescription_revision,
      JSON.stringify(prescription.medications),
    );
    if (Number(amendedPrescriptionCount) !== 1) {
      throw AppError.conflict(
        'Prescription changed before the amendment could be committed',
        'PRESCRIPTION_AMENDMENT_STALE_PRESCRIPTION',
      );
    }

    const amendedOrderCount = await tx.$executeRawUnsafe(
      `UPDATE pharmacy_orders
          SET items_list=$1::jsonb, medication=$2, total_amount=$3,
              prescribed_by=$4::uuid, inventory_authority_version=inventory_authority_version+1,
              updated_by=$4::uuid, updated_at=$5::timestamptz
        WHERE tenant_id=$6::uuid AND id=$7::int AND patient_id=$8::int
          AND facility_id=$9::int AND authority_origin='e_prescription'
          AND status='ON_HOLD' AND clinical_verification_status='rejected'
          AND inventory_authority_version=$10::int
          AND clinically_verified_order_version=$10::int
          AND clinical_verification_items_sha256=$11
          AND items_list=$12::jsonb`,
      JSON.stringify(projection.itemsList),
      projection.medications.map((line) => line.name).join(', '),
      projection.totalAmount,
      String(actor.uid),
      amendedAt,
      tid,
      orderId,
      Number(patients[0].id),
      Number(order.facility_id),
      normalized.expected_order_version,
      rejectedItemsSha256,
      JSON.stringify(order.items_list),
    );
    if (Number(amendedOrderCount) !== 1) {
      throw AppError.conflict(
        'Pharmacy order changed before the amendment could be committed',
        'PRESCRIPTION_AMENDMENT_STALE_ORDER_VERSION',
      );
    }

    const rejectedPrescriptionSnapshot = {
      id: Number(prescription.id),
      patient_id: Number(prescription.patient_id),
      patient_uid: prescription.patient_uid,
      doctor_id: Number(prescription.doctor_id),
      doctor_uid: prescription.doctor_uid,
      original_prescriber_role: prescription.original_prescriber_role,
      medications: prescription.medications,
      status: prescription.status,
      lifecycle_status: prescription.lifecycle_status,
      pharmacy_opted: prescription.pharmacy_opted,
      pharmacy_order_id: Number(prescription.pharmacy_order_id),
      revision: Number(prescription.revision),
      signed_at: prescription.signed_at,
      signed_by: prescription.signed_by,
      locked_at: prescription.locked_at,
      locked_by: prescription.locked_by,
    };
    const rejectedOrderSnapshot = {
      id: Number(order.id),
      patient_id: Number(order.patient_id),
      facility_id: Number(order.facility_id),
      order_number: order.order_number || null,
      authority_origin: order.authority_origin,
      status: order.status,
      items_list: order.items_list,
      total_amount: order.total_amount,
      payment_status: order.payment_status,
      amount_collected: order.amount_collected,
      partial_dispense: order.partial_dispense,
      dispensed_by: order.dispensed_by,
      dispensed_at: order.dispensed_at,
      dispensed_medications: order.dispensed_medications,
      prescribed_by: order.prescribed_by,
      inventory_authority_version: Number(order.inventory_authority_version),
      clinical_verification_status: order.clinical_verification_status,
      clinically_verified_order_version: Number(order.clinically_verified_order_version),
      clinical_verification_items_sha256: order.clinical_verification_items_sha256,
      clinical_verification_catalog_sha256: order.clinical_verification_catalog_sha256,
      clinical_verification_active_therapy_sha256:
        order.clinical_verification_active_therapy_sha256,
      clinical_verification_safety_version:
        order.clinical_verification_safety_version == null
          ? null
          : String(order.clinical_verification_safety_version),
      clinical_verification_kb_version: order.clinical_verification_kb_version == null
        ? null
        : String(order.clinical_verification_kb_version),
      clinical_verification_ruleset_version: order.clinical_verification_ruleset_version,
      clinically_verified_by: order.clinically_verified_by,
      clinically_verified_at: order.clinically_verified_at,
      clinical_verification_notes: order.clinical_verification_notes,
      clinical_verification_findings: order.clinical_verification_findings,
    };
    const historyEvidence = {
      event: 'rejected_prescription_amended',
      amendment_state: 'pending_reverification',
      amendment_reason: normalized.amendment_reason,
      authorization_basis: authorizationBasis,
      authorization_reason: authorizationBasis === 'same_tenant_clinical_leader'
        ? normalized.authorization_reason
        : null,
      covering_authority_id: coveringAuthorityId,
      covering_authority_source: coveringAuthoritySource,
      covering_authority_evidence: coveringAuthorityEvidence,
      controlled_privilege_id: controlledPrivilegeId,
      actor_uid: actor.uid,
      actor_role: canonicalRole,
      prior_prescriber_uid: prescription.doctor_uid || null,
      rejected_prescription_snapshot: rejectedPrescriptionSnapshot,
      rejected_order_snapshot: rejectedOrderSnapshot,
      rejected_prescription_medications: prescription.medications,
      rejected_order_items: order.items_list,
      prior_signature: {
        signed_at: prescription.signed_at,
        signed_by: prescription.signed_by,
        locked_at: prescription.locked_at,
        locked_by: prescription.locked_by,
      },
      prior_prescription_revision: normalized.expected_prescription_revision,
      prescription_revision: normalized.expected_prescription_revision + 1,
      prior_order_version: normalized.expected_order_version,
      order_version: normalized.expected_order_version + 1,
      rejected_items_sha256: rejectedItemsSha256,
      amended_items_sha256: amendedItemsSha256,
      preserved_rejection: {
        rejected_by: order.clinically_verified_by || null,
        rejected_at: order.clinically_verified_at || null,
        notes: order.clinical_verification_notes || null,
        findings: order.clinical_verification_findings || null,
        catalog_sha256: order.clinical_verification_catalog_sha256 || null,
        active_therapy_sha256: order.clinical_verification_active_therapy_sha256 || null,
        safety_version: order.clinical_verification_safety_version == null
          ? null
          : String(order.clinical_verification_safety_version),
        kb_version: order.clinical_verification_kb_version == null
          ? null
          : String(order.clinical_verification_kb_version),
        ruleset_version: order.clinical_verification_ruleset_version || null,
      },
    };
    await tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_order_history
        (tenant_id, order_id, from_status, to_status, changed_by, changed_by_role, notes, created_at)
       VALUES ($1::uuid, $2::int, 'ON_HOLD', 'ON_HOLD', $3::int, $4, $5, $6::timestamptz)`,
      tid,
      orderId,
      Number(actor.id),
      canonicalRole,
      JSON.stringify(historyEvidence),
      amendedAt,
    );

    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(patients[0].uid),
      eventType: 'pharmacy.rejected_prescription_amended',
      eventStatus: 'pending_reverification',
      sourceTable: 'e_prescriptions',
      sourceId: String(rxId),
      resourceType: 'pharmacy_order',
      resourceId: String(orderId),
      actorUid: String(actor.uid),
      actorRole: canonicalRole,
      summary: `Rejected prescription amended for order ${order.order_number || orderId}; fresh verification required`,
      payload: historyEvidence,
      beforeState: {
        prescription_revision: normalized.expected_prescription_revision,
        order_version: normalized.expected_order_version,
        status: 'ON_HOLD',
        clinical_verification_status: 'rejected',
        medications: prescription.medications,
        items_list: order.items_list,
        doctor_uid: prescription.doctor_uid,
        prescribed_by: order.prescribed_by,
        signed_at: prescription.signed_at,
        signed_by: prescription.signed_by || null,
        locked_at: prescription.locked_at,
        locked_by: prescription.locked_by || null,
        prescription: rejectedPrescriptionSnapshot,
        pharmacy_order: rejectedOrderSnapshot,
      },
      afterState: {
        prescription_revision: normalized.expected_prescription_revision + 1,
        order_version: normalized.expected_order_version + 1,
        status: 'ON_HOLD',
        clinical_verification_status: 'rejected',
        amendment_state: 'pending_reverification',
        medications: projection.medications,
        items_list: projection.itemsList,
        total_amount: projection.totalAmount,
        amended_items_sha256: amendedItemsSha256,
        doctor_uid: actor.uid,
        prescribed_by: actor.uid,
        signed_at: amendedAt,
        signed_by: actor.uid,
        locked_at: amendedAt,
        locked_by: actor.uid,
      },
      tags: ['pharmacy', 'prescription', 'rejection-amendment', 'pending-reverification'],
      timelineIdempotencyKey: `e_prescriptions:${rxId}:${ACTION}:${commandKeySha256}`,
      auditIdempotencyKey: `e_prescriptions:${rxId}:audit:${ACTION}:${commandKeySha256}`,
    }, { db: tx, strict: true });

    return { replay: false, result };
  });

  return {
    ...outcome.result,
    idempotent_replay: outcome.replay === true,
  };
}

export default { amendRejectedPrescription };
