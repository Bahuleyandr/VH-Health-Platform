import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  validatePrescriptionSafety,
  checkAntithromboticInteractions,
} from '../../utils/clinical/prescriptionSafetyCheck.js';

const INACTIVE_MEDICATION_RE =
  /cancelled|canceled|discontinued|stopped|\bheld\b|on[\s_-]?hold|suspended|completed/i;

const PRESCRIBER_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'MEDICAL_SUPERINTENDENT',
]);

const ADMINISTRATION_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'CNO',
  'ICU_NURSE',
  'ICU_INCHARGE',
]);

const PHARMACY_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
]);

function roleOf(user) {
  return String(user?.role || '').trim().toUpperCase();
}

function parseDetails(details) {
  if (!details) return {};
  if (typeof details === 'string') {
    try {
      return JSON.parse(details);
    } catch {
      return { medication_name: details };
    }
  }
  return typeof details === 'object' && !Array.isArray(details) ? details : {};
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function medicationName(details) {
  return cleanText(details.medication_name || details.name || details.medication || details.drug_name);
}

function normalizeMedicationName(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
}

function medicationPayloadFromOrder(order) {
  const details = parseDetails(order.details);
  const name = medicationName(details) || 'Medication not named';
  return {
    name,
    medication_name: name,
    dose: cleanText(details.dose || details.dosage),
    dosage: cleanText(details.dosage || details.dose),
    route: cleanText(details.route || order.route),
    frequency: cleanText(details.frequency || details.dosage_frequency || details.freq || details.dose_interval),
    duration: cleanText(details.duration || details.duration_days),
    duration_days: details.duration_days ?? details.duration ?? null,
    dose_times: Array.isArray(details.dose_times) ? details.dose_times : [],
    food_timing: cleanText(details.food_timing),
    instructions: cleanText(details.instructions || details.instruction || order.notes),
    quantity: details.quantity_requested ?? details.quantity ?? details.qty ?? null,
  };
}

function isActiveMedicationOrder(order) {
  return !INACTIVE_MEDICATION_RE.test(cleanText(order.status || 'ordered'));
}

function issueMentionsMedication(issue, targetName) {
  const normalized = normalizeMedicationName(targetName);
  if (!normalized) return false;
  const fields = [
    issue?.medication,
    issue?.name,
    ...(Array.isArray(issue?.medications) ? issue.medications : []),
  ];
  return fields.some((value) => normalizeMedicationName(value) === normalized);
}

function mapIssue(issue, severity) {
  return {
    severity,
    type: cleanText(issue?.type || issue?.interaction || 'SAFETY_FLAG'),
    message: cleanText(issue?.message || issue?.reason || JSON.stringify(issue)),
    details: issue,
  };
}

async function buildSafetyByOrder({ patientId, orders }) {
  const output = new Map();
  if (!patientId) {
    for (const order of orders) {
      output.set(order.id, {
        state: 'schema-unavailable',
        blockers: [],
        warnings: [{
          severity: 'warning',
          type: 'PATIENT_ID_UNAVAILABLE',
          message: 'Patient integer ID unavailable, so allergy/dose safety could not run.',
        }],
      });
    }
    return output;
  }

  const activeMeds = orders
    .filter(isActiveMedicationOrder)
    .map(medicationPayloadFromOrder)
    .filter((med) => med.name && med.name !== 'Medication not named');
  const duplicateCounts = activeMeds.reduce((acc, med) => {
    const key = normalizeMedicationName(med.name);
    if (key) acc.set(key, (acc.get(key) || 0) + 1);
    return acc;
  }, new Map());
  const chartInteractions = checkAntithromboticInteractions(activeMeds);

  for (const order of orders) {
    const med = medicationPayloadFromOrder(order);
    const warnings = [];
    const blockers = [];
    if (med.name && med.name !== 'Medication not named') {
      const patientSafety = await validatePrescriptionSafety(patientId, [med]);
      warnings.push(...(patientSafety.warnings || []).map((issue) => mapIssue(issue, 'warning')));
      blockers.push(...(patientSafety.blockers || []).map((issue) => mapIssue(issue, 'blocker')));

      for (const issue of chartInteractions.warnings || []) {
        if (issueMentionsMedication(issue, med.name)) warnings.push(mapIssue(issue, 'warning'));
      }
      for (const issue of chartInteractions.blockers || []) {
        if (issueMentionsMedication(issue, med.name)) blockers.push(mapIssue(issue, 'blocker'));
      }

      if ((duplicateCounts.get(normalizeMedicationName(med.name)) || 0) > 1) {
        warnings.push({
          severity: 'warning',
          type: 'DUPLICATE_INPATIENT_MEDICATION',
          message: `${med.name} appears more than once as an active inpatient order.`,
        });
      }
    }

    output.set(order.id, {
      state: blockers.length ? 'blocked' : 'fallback',
      warnings,
      blockers,
    });
  }
  return output;
}

function administrationBelongsToOrder(administration, order) {
  const notes = cleanText(administration.notes);
  if (notes.includes(`clinical_order_id:${order.id}`)) return true;

  const med = medicationPayloadFromOrder(order);
  const adminName = normalizeMedicationName(administration.medication_name);
  if (!adminName || adminName !== normalizeMedicationName(med.name)) return false;
  const sameDose = !med.dose || !administration.dose
    || cleanText(administration.dose).toLowerCase() === med.dose.toLowerCase();
  const sameRoute = !med.route || !administration.route
    || cleanText(administration.route).toLowerCase() === med.route.toLowerCase();
  return sameDose && sameRoute;
}

function indentBelongsToOrder(indent, order) {
  const items = Array.isArray(indent.items) ? indent.items : [];
  return items.some((item) => cleanText(item.notes).includes(`clinical_order_id:${order.id}`));
}

function pharmacyStatusForOrder(indents, order) {
  const linked = indents.filter((indent) => indentBelongsToOrder(indent, order));
  if (!linked.length) return isActiveMedicationOrder(order) ? 'pending_indent' : 'not_applicable';
  if (linked.some((indent) => indent.status === 'received')) return 'received_on_ward';
  if (linked.some((indent) => indent.status === 'issued')) return 'issued_by_pharmacy';
  if (linked.some((indent) => indent.status === 'approved')) return 'approved';
  if (linked.some((indent) => indent.status === 'rejected')) return 'rejected';
  return 'requested';
}

function summarizeSafetyState(rows) {
  if (rows.some((row) => row.safety?.blockers?.length)) return 'blocked';
  return 'fallback';
}

function summarizeSafetyOutcome(rows) {
  if (rows.some((row) => row.safety?.blockers?.length)) return 'blocked';
  if (rows.some((row) => row.safety?.warnings?.length)) return 'warning';
  return 'clear';
}

export async function getAdmissionDrugChart({ admissionId, tenantId = null, user = null }) {
  const id = Number.parseInt(admissionId, 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('admission_id must be a positive integer');

  const admissions = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.patient_uid, a.encounter_id, a.status, a.admitted_at,
            a.discharge_initiated_at, a.discharged_at, a.tenant_id,
            u.id AS patient_id, u.name AS patient_name, u.phone AS patient_phone,
            COALESCE((
              SELECT pi.identifier_value
                FROM patient_identifiers pi
               WHERE pi.patient_uid = u.uid
                 AND pi.identifier_type = 'mrn'
                 AND COALESCE(pi.status, 'active') = 'active'
               ORDER BY pi.is_primary DESC, pi.assigned_at DESC NULLS LAST, pi.id DESC
               LIMIT 1
            ), CASE WHEN u.id IS NULL THEN NULL ELSE 'VH-' || LPAD(u.id::text, 6, '0') END) AS hospital_id,
            b.id AS bed_id, b.bed_number, b.ward_id,
            COALESCE(w.name, b.ward_name, a.ward) AS ward_name
       FROM admissions a
       LEFT JOIN users u ON u.uid = a.patient_uid
       LEFT JOIN beds b ON b.id = a.bed_id
       LEFT JOIN wards w ON w.id = b.ward_id
      WHERE a.id = $1::int
        AND ($2::uuid IS NULL OR a.tenant_id = $2::uuid)
      LIMIT 1`,
    id,
    tenantId,
  );
  const admission = admissions[0];
  if (!admission) throw AppError.notFound('Admission not found');

  const [orders, administrations, indents] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT co.id, co.order_number, co.encounter_id, co.patient_uid, co.order_type,
              co.priority, co.details, co.route, co.status, co.ordered_by,
              co.verified_by, co.verified_at, co.completed_by, co.completed_at,
              co.cancelled_by, co.cancel_reason, co.start_date, co.end_date,
              co.notes, co.created_at, co.updated_at,
              ou.name AS ordered_by_name,
              vu.name AS verified_by_name,
              cu.name AS cancelled_by_name
         FROM clinical_orders co
         LEFT JOIN users ou ON ou.uid = co.ordered_by
         LEFT JOIN users vu ON vu.uid = co.verified_by
         LEFT JOIN users cu ON cu.uid = co.cancelled_by
        WHERE co.patient_uid = $1::uuid
          AND co.order_type = 'medication'
          AND (
            ($2::uuid IS NOT NULL AND co.encounter_id = $2::uuid)
            OR (
              co.created_at >= COALESCE($3::timestamptz, co.created_at)
              AND co.created_at <= COALESCE($4::timestamptz, NOW() + INTERVAL '14 days')
            )
          )
          AND ($5::uuid IS NULL OR co.tenant_id = $5::uuid)
        ORDER BY co.created_at DESC, co.id DESC`,
      admission.patient_uid,
      admission.encounter_id,
      admission.admitted_at,
      admission.discharged_at,
      tenantId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT ma.id, ma.patient_uid, ma.prescription_id, ma.medication_name,
              ma.dose, ma.dosage, ma.route, ma.scheduled_time,
              ma.administered_at, ma.administered_by, ma.status, ma.notes,
              ma.witness_uid, ma.hold_reason, ma.refusal_reason,
              ma.scanned_patient_uid, ma.scanned_barcode, ma.rights_passed,
              ma.all_rights_passed, ma.override_reason, ma.created_at, ma.updated_at,
              au.name AS administered_by_name
         FROM medication_administrations ma
         LEFT JOIN users au ON au.uid = ma.administered_by
        WHERE ma.patient_uid = $1::uuid
          AND ($2::timestamptz IS NULL OR ma.scheduled_time IS NULL OR ma.scheduled_time >= ($2::timestamptz - INTERVAL '12 hours'))
          AND (ma.scheduled_time IS NULL OR ma.scheduled_time < COALESCE($3::timestamptz, NOW() + INTERVAL '14 days'))
          AND ($4::uuid IS NULL OR ma.tenant_id = $4::uuid)
        ORDER BY ma.scheduled_time ASC NULLS LAST, ma.created_at ASC`,
      admission.patient_uid,
      admission.admitted_at,
      admission.discharged_at,
      tenantId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT wi.id, wi.indent_number, wi.status, wi.ward_id, wi.ward_name,
              wi.requested_by, wi.requested_at, wi.approved_by, wi.approved_at,
              wi.issued_by, wi.issued_at, wi.received_by, wi.received_at,
              wi.rejection_reason, wi.notes,
              COALESCE(
                json_agg(json_build_object(
                  'id', wii.id,
                  'item_name', wii.item_name,
                  'quantity_requested', wii.quantity_requested,
                  'quantity_issued', wii.quantity_issued,
                  'unit', wii.unit,
                  'notes', wii.notes
                ) ORDER BY wii.id) FILTER (WHERE wii.id IS NOT NULL),
                '[]'::json
              ) AS items
         FROM ward_indents wi
         LEFT JOIN ward_indent_items wii ON wii.ward_indent_id = wi.id
        WHERE wi.admission_id = $1::int
          AND wi.indent_type = 'pharmacy'
          AND ($2::uuid IS NULL OR wi.tenant_id = $2::uuid)
        GROUP BY wi.id
        ORDER BY wi.requested_at DESC`,
      id,
      tenantId,
    ),
  ]);

  const safetyByOrder = await buildSafetyByOrder({
    patientId: admission.patient_id,
    orders,
  });

  const medicationOrders = orders.map((order) => {
    const administrationsForOrder = administrations.filter((ma) => administrationBelongsToOrder(ma, order));
    const safety = safetyByOrder.get(order.id) || { state: 'schema-unavailable', warnings: [], blockers: [] };
    return {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      priority: order.priority,
      details: medicationPayloadFromOrder(order),
      ordered_by: order.ordered_by,
      ordered_by_name: order.ordered_by_name,
      verified_by: order.verified_by,
      verified_by_name: order.verified_by_name,
      verified_at: order.verified_at,
      cancelled_by: order.cancelled_by,
      cancelled_by_name: order.cancelled_by_name,
      cancel_reason: order.cancel_reason,
      start_date: order.start_date,
      end_date: order.end_date,
      created_at: order.created_at,
      updated_at: order.updated_at,
      pharmacy_status: pharmacyStatusForOrder(indents, order),
      safety,
      administrations: administrationsForOrder,
    };
  });

  return {
    admission,
    permissions: {
      can_prescribe: PRESCRIBER_ROLES.has(roleOf(user)),
      can_administer: ADMINISTRATION_ROLES.has(roleOf(user)),
      can_dispense: PHARMACY_ROLES.has(roleOf(user)),
    },
    governance: {
      state: summarizeSafetyState(medicationOrders),
      outcome: summarizeSafetyOutcome(medicationOrders),
      label: 'Rules-based medication safety',
      source_count: orders.length + administrations.length + indents.length,
      generated_at: new Date().toISOString(),
      human_review_required: medicationOrders.some((row) => row.safety?.blockers?.length),
      notes: 'Drug chart safety uses deterministic allergy, duplicate, dose, and interaction rules; no silent AI action was used.',
    },
    medication_orders: medicationOrders,
    administrations,
    pharmacy_indents: indents,
  };
}

export default { getAdmissionDrugChart };
