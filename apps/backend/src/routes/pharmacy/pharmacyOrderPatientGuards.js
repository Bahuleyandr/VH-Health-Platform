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
// use a synthetic non-PATIENT users row ('PHARMACY_WALKIN').
//
// selectOrderPatient resolves patient_id ONLY — there is no phone fallback.
// Phone is contact data, not durable ownership authority, so a legacy
// phone-only order stays unresolved until governed patient recovery attaches
// a patient_id to the row. selectCounterSalePatient likewise resolves the
// sale row patient_uid and returns null when no registered patient is
// attached.
//
// FORCING PATIENT CONTEXT is a per-route decision, not a property of the
// selector:
//   * Order-keyed routes in orderRoutes.js — /orders/:id and every action
//     under it, plus /orders/uid/:uid — DO force it. Each names exactly one
//     order or one patient, so a subject that will not resolve must refuse
//     rather than fall through to the handler on the role gate alone.
//   * Counter sales (counterSaleRoutes.js) do NOT force it: an anonymous
//     walk-in sale is a legitimate subject-less row and keeps working on the
//     role gate, while every attached-patient sale still gets a real
//     relationship decision. The body-order dispense guard in index.js is
//     unforced for the same reason.
//   * Body-named subjects the handler itself requires (dispense-substitution
//     and its witness request, both keyed on body.patient_uid) DO force it.
//
// Under care-team mode 'enforce' a forcing guard answers 403
// PATIENT_CONTEXT_REQUIRED for an unknown or cross-tenant id. That is the
// intended posture, not a regression: a 404 there would leak cross-tenant
// row existence. In 'shadow'/'off' the unresolved attempt is recorded and
// the handler answers for itself.
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

// Selector: pharmacy_orders id (path param or body field) → the order's exact
// patient_id owner. Phone is contact data, never durable ownership authority.
// Legacy phone-only orders remain unresolved until governed patient recovery.
//
// A missing / out-of-tenant order resolves to null like every other selector
// in this file and in middleware/routePatientAccessGuards.js. It must NOT
// throw a 404: patientAccessGuard's catch treats ANY selector throw as a
// broken authorization engine and answers 500 PATIENT_ACCESS_CHECK_FAILED
// (middleware/phiAccessMiddleware.js) — it never reads err.statusCode — so a
// throw here turned every unknown order id into a 500. With null the guard
// refuses cleanly (403 PATIENT_CONTEXT_REQUIRED under enforce) or records the
// unresolved attempt and lets the handler answer for itself (shadow/off).
//
// What the handler answers on that path is NOT this selector's contract to
// state, and today it is not a 404. Every pharmacy order action that
// resolves facility custody first — cancel, confirm, dispatch, dispense,
// unavailable, detail, label, dispensable — calls
// resolveOrderPharmacyFacility (services/pharmacy/
// pharmacyFacilityAuthorityService.js:380-399) AHEAD of its own not-found
// branch, and an id that names no row has no facility either, so the miss
// is answered 409 PHARMACY_ORDER_FACILITY_UNRESOLVED. That ordering is the
// handlers' to fix (it is pinned red by pharmacy-lifecycle-deep.test.js's
// 'returns 404 for an unknown order id'); this selector only guarantees it
// does not turn the miss into a 500.
export function selectOrderPatient(readOrderId) {
  return async (req) => {
    const orderId = positiveInt(readOrderId(req));
    const tenantId = tenantOf(req);
    if (orderId === null || !tenantId) return null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT po.id AS order_id, p.id, p.uid
         FROM pharmacy_orders po
         LEFT JOIN users p
           ON p.tenant_id = po.tenant_id
          AND p.role = 'PATIENT'
          AND p.id = po.patient_id
          AND p.is_active=TRUE AND p.status='active'
          AND p.is_deleted=FALSE AND p.merged_into_uid IS NULL
        WHERE po.tenant_id = $1::uuid
          AND po.id = $2::int
        LIMIT 1`,
      tenantId,
      orderId,
    );
    // No row (unknown / out-of-tenant order) and a row whose LEFT JOIN found
    // no live PATIENT owner both resolve to null.
    const row = rows[0];
    return row?.id && row?.uid
      ? { id: row.id, uid: row.uid }
      : null;
  };
}

// Selector: a phone in the request body. Matches the stored E.164 form or
// the digits-only legacy form, exactly like accessDecisionService's phone
// resolution; an unregistered phone yields null.
//
// NO ROUTE CONSUMES THIS TODAY. It guarded the legacy phone-keyed
// POST /orders create, which was retired with the rest of the legacy
// lifecycle (see orderRoutes.js). It is kept — exported and covered by
// tests/unit/pharmacyMountRouteGuards.test.js — because phone-keyed body
// creates are the shape any restored legacy surface would take, and
// re-deriving the E.164/digits match is how that resolution drifts out of
// step with accessDecisionService's.
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
