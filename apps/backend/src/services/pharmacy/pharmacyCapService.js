// src/services/pharmacy/pharmacyCapService.js
//
// TPA pharmacy-cap probe at dispense time.
// See finding 2026-05-09-tpa-insurance-claim-billing-pharmacy-cap-not-enforced.
//
// The legacy pharmacy dispense paths (markCounterDispensed,
// markDelivered) decremented stock and stamped DELIVERED with zero
// awareness of the patient's TPA pharmacy cap. For an admitted patient
// whose insurer approved (say) INR 15,000 for pharmacy, staff could
// silently dispense INR 20,000 worth of medicines; the overshoot only
// surfaced at discharge reconciliation, by which time the medicines
// were already gone and the hospital had to write off the gap.
//
// Probe shape:
//   - No active admission ⇒ unscoped (walk-in / OPD). Skip the cap.
//   - Admission has no TPA claim or preauth ⇒ no cap to enforce.
//   - Admission has cap data ⇒ compute current pharmacy spend +
//     proposed dispense; return { level: 'ok'|'warn'|'critical' }.
//
// Phase 1 = hard block at level='critical' unless allowOverride.
// Phase 1.5 = warn at level='warn' (caller logs; we do not block).

import prisma from '../../lib/prisma.js';

export const PHARMACY_CAP_WARN_PCT = 80;
export const PHARMACY_CAP_CRITICAL_PCT = 100;

/**
 * @param {Object} args
 * @param {number} [args.patientId]   pharmacy_orders.patient_id (int FK to users.id)
 * @param {string} [args.patientUid]  alternate entry — users.uid
 * @param {number} args.additionalAmount  rupees the caller is about to dispense
 * @returns {Promise<{
 *   hasCap: boolean,
 *   admissionId: number|null,
 *   pharmacyCap: number|null,
 *   currentSpend: number,
 *   projectedTotal: number,
 *   utilisationPct: number,
 *   level: 'ok'|'warn'|'critical',
 *   message: string|null,
 * }>}
 */
export async function probePharmacyCap({
  patientId, patientUid, additionalAmount = 0,
}) {
  const extra = Math.max(0, Number(additionalAmount) || 0);
  const noCap = {
    hasCap: false,
    admissionId: null,
    pharmacyCap: null,
    currentSpend: 0,
    projectedTotal: extra,
    utilisationPct: 0,
    level: 'ok',
    message: null,
  };
  if (!patientId && !patientUid) return noCap;

  // Resolve uid from int id if only id was supplied. pharmacy_orders.patient_id
  // is the legacy int FK; admissions key by uuid.
  let uid = patientUid ? String(patientUid) : null;
  if (!uid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users WHERE id = $1::int LIMIT 1`,
      Number(patientId),
    );
    if (!rows.length || !rows[0].uid) return noCap;
    uid = String(rows[0].uid);
  }

  // Active admission for this patient. If they're not admitted, the
  // dispense is OPD/walk-in and falls outside any TPA pharmacy cap.
  const admRows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id FROM admissions
      WHERE patient_uid = $1::uuid
        AND status = 'admitted'
      ORDER BY admitted_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    uid,
  );
  if (!admRows.length) return noCap;
  const admissionId = admRows[0].id;

  const pharmacyCap = await resolvePharmacyCap(admissionId);
  if (pharmacyCap == null) return { ...noCap, admissionId };

  const currentSpend = await sumAdmissionPharmacySpend(admissionId);
  const projectedTotal = currentSpend + extra;
  const utilisationPct = pharmacyCap > 0
    ? Math.round((projectedTotal / pharmacyCap) * 1000) / 10
    : 0;

  let level = 'ok';
  if (utilisationPct >= PHARMACY_CAP_CRITICAL_PCT) level = 'critical';
  else if (utilisationPct >= PHARMACY_CAP_WARN_PCT) level = 'warn';

  const message = level === 'critical'
    ? `Pharmacy dispense would push admission ${admissionId} to INR ${projectedTotal.toFixed(2)} ` +
      `against TPA pharmacy cap INR ${pharmacyCap.toFixed(2)} (${utilisationPct}%). ` +
      `Collect patient liability or raise enhancement preauth before continuing.`
    : level === 'warn'
      ? `Pharmacy dispense will reach INR ${projectedTotal.toFixed(2)} of the ` +
        `INR ${pharmacyCap.toFixed(2)} TPA pharmacy cap (${utilisationPct}%). ` +
        `Warn patient + consider enhancement preauth.`
      : null;

  return {
    hasCap: true,
    admissionId,
    pharmacyCap,
    currentSpend,
    projectedTotal,
    utilisationPct,
    level,
    message,
  };
}

/**
 * Resolve the live pharmacy cap (INR) for an admission, checking the
 * structured caps table first (insurance_claim_caps, category='pharmacy'),
 * then falling back to the latest preauth response's raw_response.caps.
 * Returns null when no pharmacy cap is set for this admission.
 */
async function resolvePharmacyCap(admissionId) {
  // 1. Structured cap on the admission's TPA claim (insurance_claim_caps).
  const capRows = await prisma.$queryRawUnsafe(
    `SELECT cap.max_amount
       FROM insurance_claim_caps cap
       JOIN tpa_claims c ON c.id = cap.tpa_claim_id
      WHERE c.admission_id = $1::int
        AND cap.category = 'pharmacy'
      ORDER BY cap.updated_at DESC, cap.id DESC
      LIMIT 1`,
    Number(admissionId),
  );
  if (capRows.length && capRows[0].max_amount != null) {
    return Number(capRows[0].max_amount);
  }
  // 2. Raw cap inside the latest preauth response for this admission.
  const respRows = await prisma.$queryRawUnsafe(
    `SELECT r.raw_response
       FROM insurance_preauth_responses r
       JOIN insurance_preauth p ON p.id = r.preauth_id
      WHERE p.admission_id = $1::int
      ORDER BY r.decided_at DESC, r.id DESC
      LIMIT 1`,
    Number(admissionId),
  );
  if (!respRows.length) return null;
  return extractPharmacyCapFromRaw(respRows[0].raw_response);
}

/**
 * Pull the pharmacy max_amount out of an insurer raw_response payload.
 * Supports the nested `caps.pharmacy.max_amount` shape and the flat
 * `pharmacy_cap` legacy field. Returns null when no usable number is
 * present. Exported for unit testing.
 */
export function extractPharmacyCapFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pharm = raw.caps?.pharmacy?.max_amount ?? raw.pharmacy_cap;
  if (pharm == null) return null;
  const n = Number(pharm);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sum the pharmacy-category line items already billed for this
 * admission. Discounts and refunds are ignored at the dispense check —
 * the cap is gross-of-discount; settlement reconciles later.
 */
async function sumAdmissionPharmacySpend(admissionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(it.line_total), 0)::numeric AS spend
       FROM billing_invoice_items it
       JOIN billing_invoices inv ON inv.id = it.invoice_id
      WHERE inv.admission_id = $1::int
        AND inv.status <> 'VOID'
        AND it.category = 'pharmacy'`,
    Number(admissionId),
  );
  return Number(rows[0]?.spend ?? 0);
}

/**
 * Hard-block decision: critical level blocks unless the caller passed
 * an explicit override flag (typically gated by RBAC at the route layer).
 */
export function shouldBlockDispense(probe, { allowOverride = false } = {}) {
  if (!probe?.hasCap) return false;
  if (probe.level !== 'critical') return false;
  return !allowOverride;
}
