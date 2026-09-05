// apps/backend/src/services/clinical/cathLabReadinessProjection.js
//
// ROLE PROJECTION for the pre-procedure lab readiness surfaces. Pure: no I/O,
// no clock, no tenant — it takes what the readiness resolver produced and
// answers what a given role may read of it.
//
// Why it exists
// -------------
// GET /cases/:id/readiness/labs and the `lab_readiness` block on GET /cases/:id
// are cath REPORT-READ, which admits RECEPTIONIST and TECHNICIAN — roles that
// sit outside CLINICAL_STAFF_ROUTE_ROLES. The report-read gate is correct (the
// front desk legitimately needs to see "labs pending" before a case is called),
// but the items carry `value_text` / `value_numeric` / `abnormal_flag` for
// `hiv`, `hbsag` and `hcv`: a patient's blood-borne serology in plain sight,
// and exactly the narrative projectReuseRestrictionForRole redacts for the same
// two roles one key over on the very same responses. Without this the narrower
// surface was simply the way round the wider one.
//
// The audience predicate is cathDeviceReuseService.roleSeesSerologyDetail — the
// SAME function the reuse strip is projected through, deliberately not a second
// list, so the two can never disagree about what a receptionist may read.
//
// BLANK IT, DON'T DROP IT. CathLabReadinessItem is additionalProperties:false
// with every key required, so a redacted item must keep its key set exactly and
// carry nulls. `state`, `observed_at`, `is_critical`, `source` and the three
// waiver keys survive: those are the CHECKLIST — whether the marker is on file,
// when, from where, whether it is flagged, and who waived it — which is what
// the front desk is admitted for. What is removed is WHICH result came back.
//
// `is_critical` (and therefore the readiness block's `critical_items`, which is
// derived from it) is deliberately retained: it is the flag the operator at the
// table acts on, it says nothing about the direction or the value, and blanking
// it would leave the two fields disagreeing.

import { BLOODBORNE_MARKER_ITEM_CODES } from '../lab/labAnalyteCodes.js';
import { roleSeesSerologyDetail } from './cathDeviceReuseService.js';

/** The three qualitative marker items, straight from the analyte map. */
const SEROLOGY_ITEM_CODES = new Set(BLOODBORNE_MARKER_ITEM_CODES);

/** The value-bearing keys a non-clinical reader must not see on those items. */
export const REDACTED_SEROLOGY_ITEM_KEYS = Object.freeze([
  'value_text', 'value_numeric', 'abnormal_flag',
]);

export function isSerologyItemCode(code) {
  return SEROLOGY_ITEM_CODES.has(String(code ?? ''));
}

/** One readiness item, redacted if it is serology. Key set is never changed. */
function redactItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  if (!isSerologyItemCode(item.item_code)) return item;
  const projected = { ...item };
  for (const key of REDACTED_SEROLOGY_ITEM_KEYS) {
    // Only keys the producer actually emitted — an absent key stays absent
    // rather than being added back as null, for the same additionalProperties
    // reason the present ones stay present.
    if (key in projected) projected[key] = null;
  }
  return projected;
}

/** A readiness `items[]` array projected for `role`. */
export function projectLabReadinessItemsForRole(items, role) {
  if (!Array.isArray(items) || roleSeesSerologyDetail(role)) return items;
  return items.map(redactItem);
}

/**
 * refreshCaseLabReadiness()'s return, projected for `role`.
 *
 * Null / undefined pass straight through: `lab_readiness` is null when the
 * read-through refresh degraded, and undefined when the caller never carried
 * the key — inventing it would break CathLabCase's additionalProperties:false.
 */
export function projectLabReadinessForRole(readiness, role) {
  if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness)) return readiness;
  if (roleSeesSerologyDetail(role)) return readiness;
  if (!Array.isArray(readiness.items)) return readiness;
  return { ...readiness, items: readiness.items.map(redactItem) };
}

/**
 * The `readiness[]` CHECK rows GET /cases/:id returns, projected for `role`.
 *
 * The labs check's `metadata.live_evidence` is a verbatim copy of the same
 * `items[]` — written by the refresh so the ward can see what the automation
 * decided on — and the whole metadata jsonb reaches the client. Redacting only
 * `lab_readiness.items` would leave the identical values one key over, so the
 * copy is projected by the same rule rather than stripped: a client reading
 * live_evidence for the pending reason keeps a well-formed item list.
 */
export function projectReadinessChecksForRole(checks, role) {
  if (!Array.isArray(checks) || roleSeesSerologyDetail(role)) return checks;
  return checks.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const metadata = row.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return row;
    if (!Array.isArray(metadata.live_evidence)) return row;
    return {
      ...row,
      metadata: { ...metadata, live_evidence: metadata.live_evidence.map(redactItem) },
    };
  });
}

export default {
  isSerologyItemCode,
  projectLabReadinessForRole,
  projectLabReadinessItemsForRole,
  projectReadinessChecksForRole,
  REDACTED_SEROLOGY_ITEM_KEYS,
};
