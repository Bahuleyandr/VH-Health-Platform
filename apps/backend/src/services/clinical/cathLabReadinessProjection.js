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
// carry nulls. `state`, `observed_at`, `source` and the three waiver keys
// survive: those are the CHECKLIST — whether the marker is on file, when, from
// where, who waived it — which is what the front desk is admitted for. What is
// removed is WHICH result came back.
//
// CRITICALITY IS PART OF THE RESULT, on these three items only. `is_critical`
// is an ordinary flag on a quantitative item — a potassium can be critical high
// or critical low — but hiv/hbsag/hcv are qualitative, and nothing except a
// REACTIVE marker makes one critical. So `is_critical: true` on the `hbsag` row,
// and the bare code sitting in `critical_items`, disclose precisely what the
// three blanked keys withhold. For roles outside the serology audience both are
// therefore withheld as well: the item's `is_critical` is forced to false (the
// key stays — the schema says boolean, not nullable), and serology codes are
// dropped from `critical_items` at the top level and from the labs check row's
// `metadata.critical_items`. Audience roles read the object unchanged.
//
// `critical_warning` is deliberately left alone. It says "a critical value
// exists on this case" without naming the item, which is the advisory the front
// desk is admitted for; a critical potassium sets the same true, so the flag on
// its own names nothing.

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
  // A serology item is critical only when it is reactive, so the flag is the
  // result. false, not null: the schema types it boolean.
  if ('is_critical' in projected) projected.is_critical = false;
  return projected;
}

/**
 * A `critical_items` list with the serology codes dropped.
 *
 * Dropping, not blanking: this is a list of item codes, not a fixed key set,
 * and a placeholder in it would name the item just as loudly.
 */
function redactCriticalItems(codes) {
  return codes.filter((code) => !isSerologyItemCode(code));
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
  const hasItems = Array.isArray(readiness.items);
  const hasCriticalItems = Array.isArray(readiness.critical_items);
  if (!hasItems && !hasCriticalItems) return readiness;
  const projected = { ...readiness };
  if (hasItems) projected.items = readiness.items.map(redactItem);
  if (hasCriticalItems) projected.critical_items = redactCriticalItems(readiness.critical_items);
  return projected;
}

/**
 * The `readiness[]` CHECK rows GET /cases/:id returns, projected for `role`.
 *
 * The labs check's `metadata.live_evidence` is a verbatim copy of the same
 * `items[]` — written by the refresh so the ward can see what the automation
 * decided on — and `metadata.critical_items` is the same list as the readiness
 * block's. The whole metadata jsonb reaches the client, so redacting only
 * `lab_readiness` would leave the identical values and the identical item names
 * one key over: the copy is projected by the same rule rather than stripped, so
 * a client reading live_evidence for the pending reason keeps a well-formed
 * item list.
 */
export function projectReadinessChecksForRole(checks, role) {
  if (!Array.isArray(checks) || roleSeesSerologyDetail(role)) return checks;
  return checks.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const metadata = row.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return row;
    const hasEvidence = Array.isArray(metadata.live_evidence);
    const hasCriticalItems = Array.isArray(metadata.critical_items);
    if (!hasEvidence && !hasCriticalItems) return row;
    const projectedMetadata = { ...metadata };
    if (hasEvidence) projectedMetadata.live_evidence = metadata.live_evidence.map(redactItem);
    if (hasCriticalItems) {
      projectedMetadata.critical_items = redactCriticalItems(metadata.critical_items);
    }
    return { ...row, metadata: projectedMetadata };
  });
}

export default {
  isSerologyItemCode,
  projectLabReadinessForRole,
  projectLabReadinessItemsForRole,
  projectReadinessChecksForRole,
  REDACTED_SEROLOGY_ITEM_KEYS,
};
