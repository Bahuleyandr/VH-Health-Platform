// src/routes/pharmacy/pharmacyOrderPatientGuards.js
//
// Per-route patient access guards for the /api/v1/pharmacy-orders and
// /api/v1/pharmacy mounts (record type PHARMACY_ORDER, care-team-mode
// governed — per-tenant mode, default shadow).
//
// WHY PER-ROUTE. Those mounts previously wrapped the whole router in
// patientAccessGuard('PHARMACY_ORDER', ...) at the MOUNT. A mount-level guard
// runs before Express matches the route, so req.params is empty there: every
// route that names its subject only in the path (/orders/:id, /uid/:uid,
// /counter-sales/:id, ...) resolved no patient and the guard returned
// no_patient_context without evaluating a policy — in shadow AND in enforce.
// The guards now live on the routes, each with a selector that resolves THE
// ROW THE HANDLER SERVES (same identifier the handler uses, explicit tenant
// predicate), so the decision, the audit row and the disclosure are the same
// patient by construction. Same pattern as routes/clinical/bcmaRoutes.js and
// routes/abdm/abdmHiuRoutes.js.
//
// SUBJECT MODEL. pharmacy_orders.patient_id is NULLABLE and phone is NOT
// NULL: patient-app orders carry patient_id; legacy phone-keyed orders may
// carry only a phone; true walk-ins may match no registered patient at all.
// Counter sales (pharmacy_counter_sales.patient_uid, nullable) are anonymous
// by design unless a registered patient is attached, and anonymous identities
// use a synthetic non-PATIENT users row ('PHARMACY_WALKIN'). Order/sale
// selectors therefore resolve patient_id → phone (orders) or patient_uid
// (sales) and return null when no REGISTERED PATIENT is the subject; the
// guards on those routes do NOT force patient context, so a subject-less
// order or sale keeps working on the role gate alone while every
// registered-patient row gets a real relationship decision. Routes whose
// subject is named directly (/uid/:uid, dispense-substitution's
// body.patient_uid) DO force patient context: there a single subject always
// exists and an unresolvable one must refuse rather than fall through.
//
// Every selector returns null (never throws) on malformed input, a missing
// row, an out-of-tenant row, or a subject that is not a PATIENT user.

import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';

export function tenantOf(req) {
  return req.tenantId ?? req.user?.tenant_id ?? req.user?.tenantId ?? null;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

// pharmacy_counter_sales.id is a BigInt — digit-string validation, bound as
// ::bigint (the int4-bounded positiveInt would reject ids above int4 max).
function positiveBigIntString(value) {
  const text = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    const parsed = BigInt(text);
    return parsed > 0n && parsed <= 9223372036854775807n ? text : null;
  } catch {
    return null;
  }
}

// Guard factory: keeps the mount's record type + careTeamModeGoverned option,
// and stamps metadata the route pin tests read off the router stack.
export function pharmacyOrderGuard(patientSelector, { requirePatientContext = false } = {}) {
  const mw = patientAccessGuard('PHARMACY_ORDER', {
    careTeamModeGoverned: true,
    patientSelector,
    ...(requirePatientContext ? { requirePatientContext: true } : {}),
  });
  mw.__patientGuard = Object.freeze({
    recordType: 'PHARMACY_ORDER',
    careTeamModeGoverned: true,
    requirePatientContext,
    hasSelector: typeof patientSelector === 'function',
  });
  return mw;
}

// Selector: pharmacy_orders id (path param or body field) → the order's
// patient. patient_id join first; for phone-only legacy rows, the order's
// stored phone identifies the patient. Tenant-scoped on the order AND the
// user row; ORDER BY mirrors accessDecisionService#patientByIdOrUid so a
// multi-match phone converges on the same patient the engine would pick.
export function selectOrderPatient(readOrderId) {
  return async (req) => {
    const orderId = positiveInt(readOrderId(req));
    const tenantId = tenantOf(req);
    if (orderId === null || !tenantId) return null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.uid
         FROM pharmacy_orders po
         JOIN users p
           ON p.tenant_id = po.tenant_id
          AND p.role = 'PATIENT'
          AND (
            (po.patient_id IS NOT NULL AND p.id = po.patient_id)
            OR (po.patient_id IS NULL AND p.phone = po.phone)
          )
        WHERE po.tenant_id = $1::uuid
          AND po.id = $2::int
        ORDER BY p.registered_at DESC NULLS LAST, p.id DESC
        LIMIT 1`,
      tenantId,
      orderId,
    );
    return rows[0] ?? null;
  };
}

// Selector: a phone in the request body (legacy POST /orders — the handler
// resolves the target patient purely from body.phone / body.phoneNumber).
// Matches the stored E.164 form or the digits-only legacy form, exactly like
// accessDecisionService's phone resolution. An unregistered phone yields null
// — the walk-in create proceeds on the role gate.
export async function selectPatientByBodyPhone(req) {
  const raw = req.body?.phone ?? req.body?.phoneNumber;
  const tenantId = tenantOf(req);
  if (raw == null || raw === '' || !tenantId) return null;
  const text = String(raw).trim();
  const digits = text.replace(/\D/g, '');
  const phoneDigits = digits.length >= 10 ? digits.slice(-10) : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = 'PATIENT'
        AND (
          phone = $2::text
          OR ($3::text IS NOT NULL AND REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $3::text)
        )
      ORDER BY registered_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    tenantId,
    text,
    phoneDigits,
  );
  return rows[0] ?? null;
}

// Selector: counter-sale id → the sale's attached registered patient, if any.
// Anonymous sales (patient_uid NULL, or the synthetic 'PHARMACY_WALKIN'
// identity row) resolve null on the role predicate and stay role-gated.
export async function selectCounterSalePatient(req) {
  const saleId = positiveBigIntString(req.params?.id);
  const tenantId = tenantOf(req);
  if (saleId === null || !tenantId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.uid
       FROM pharmacy_counter_sales cs
       JOIN users p
         ON p.tenant_id = cs.tenant_id
        AND p.uid = cs.patient_uid
        AND p.role = 'PATIENT'
      WHERE cs.tenant_id = $1::uuid
        AND cs.id = $2::bigint
      LIMIT 1`,
    tenantId,
    saleId,
  );
  return rows[0] ?? null;
}

// Selector: an optional body.patient_uid (counter-sale create, witness
// requests). The object form is validated by resolvePatientForAccess against
// users with the tenant + role='PATIENT' predicate; a synthetic walk-in uid
// or a malformed value resolves to null.
export function selectPatientFromBodyUid(req) {
  const uid = req.body?.patient_uid ?? req.body?.patientUid;
  return uid == null || uid === '' ? null : { uid };
}
