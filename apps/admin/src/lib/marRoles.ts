// MAR due-list role contract — OPEN-11.
//
// Mirrors MAR_DUE_LIST_ROLES in
// apps/backend/src/routes/clinical/clinicalRoutes.js:145-153, the set enforced
// by requireMarDueListRole (:186-191) over the two reads /dashboard/mar fires
// on load: GET /clinical/mar/due (:899) and GET /clinical/mar/overdue (:877).
//
// ADMIN and SUPER_ADMIN are absent DELIBERATELY, and only from this one set.
// The adjacent backend constants show the line is drawn on purpose rather than
// by omission:
//
//   MEDICATION_ADMINISTRATION_ROLES  (clinicalRoutes.js:126-137) - admits both
//   MAR_SUPPLY_RECONCILIATION_ROLES  (:138-144)                  - admits both
//   POST /mar/verify                 (:437-442)                  - no role gate
//   wristband print                  (bcmaRoutes.js:50,120)      - admits both,
//     by explicit owner decision of 2026-08-25, audited as
//     'wristband-print-administrative-access'
//
// So this list must NOT be promoted into routePolicy.ts as a route-level gate:
// that would revoke three administrator grants the backend deliberately makes
// in order to silence one it does not. Enumerating every due dose in the
// hospital is the nursing act; the rest of the page is not.
//
// If the backend widens or narrows requireMarDueListRole, re-derive this list
// and its pin in src/__tests__/dashboard/mar-due-list-gate.test.tsx together.
export const MAR_DUE_LIST_ROLES = [
  "NURSING_STAFF",
  "NURSING_INCHARGE",
  "IP_STAFF_NURSE",
  "IP_INCHARGE",
  "CNO",
  "ICU_NURSE",
  "ICU_INCHARGE",
  "ICU_STAFF",
];
