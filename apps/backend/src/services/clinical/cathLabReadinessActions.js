// apps/backend/src/services/clinical/cathLabReadinessActions.js
//
// The four WRITES the pre-procedure lab checklist offers: waive an item, lift a
// waiver, order what is missing, and record an outside laboratory's result.
// Spec §8 of
// docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
//
// They are separated from cathLabReadinessService.js (which persists and
// refreshes the snapshot) because they are the only code here that reaches
// OUTSIDE the readiness tables: orderService places real investigation orders,
// labResultsService mints the one external-origin lab row this platform allows,
// and bloodborneMarkerService writes the marker record. Keeping the persistence
// module free of those three keeps the read path's import graph small.
//
// Cycles. This module imports caseRowTx / recordReadinessAudit /
// refreshCaseLabReadiness back from cathLabReadinessService.js, which re-exports
// this module — a deliberate ES-module cycle, and a safe one: all three are
// hoisted `function` declarations and none of them is called while either
// module is still evaluating. The alternative (a fourth module holding two
// helpers) buys nothing and costs a file.
//
// The outside-lab escape: recordExternalLabResultRow is imported here and
// NOWHERE else on this side of the graph, which is what
// tests/unit/labExternalResultCallSites.test.js pins.

import { createHash } from 'node:crypto';

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { createInvestigationOrder } from '../investigation/orderService.js';
import { recordExternalLabResultRow } from '../lab/labResultsService.js';
import { LAB_ANALYTE_ITEMS } from '../lab/labAnalyteCodes.js';
import { recordMarkers } from './bloodborneMarkerService.js';
import { clinicalDate, normalizeSerologyValue } from './bloodborneMarkerRules.js';
import {
  caseRowTx,
  recordReadinessAudit,
  refreshCaseLabReadiness,
} from './cathLabReadinessService.js';
import {
  ITEM_CODES,
  externalNumericValue,
  isCalendarDate,
  toMs,
} from './cathLabReadinessRules.js';
import {
  cleanText,
  positiveInt,
  requireUuid,
  tenantOr,
} from './cathParamGuards.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
// ---------------------------------------------------------------------------
// Actions: waive, un-waive, order the missing, record an outside result
// ---------------------------------------------------------------------------

function requireItem(value) {
  const item = String(value ?? '').trim().toLowerCase();
  if (!ITEM_CODES.includes(item)) {
    throw AppError.badRequest(
      `item must be one of ${ITEM_CODES.join(', ')}`,
      'CATH_LAB_READINESS_ITEM_UNKNOWN',
    );
  }
  return item;
}

// THE START GATE, AND WHY THE TWO WAIVER ROUTES MOVE IT IN OPPOSITE DIRECTIONS.
// Read this before touching either waiveLabItem or unwaiveLabItem below.
//
// RECORDING a waiver after actual_start_at is ALLOWED. That is the
// less-restrictive direction the owner asked for: "in emergencies with no
// reports immediately available we will proceed with no reports and we might
// add while the procedure is ongoing and the reports become available; we do
// not want the pre-cath checklist to be restrictive as principle." A team
// already at the table is exactly the team that has to record "proceeding
// without HCV", and refusing the write does not stop them proceeding — it only
// stops the decision being written down. The lateness is DOCUMENTED instead:
// recorded_after_start on the audit row, and the same boolean derived onto the
// item itself so the ward sees it too.
//
// LIFTING a waiver after actual_start_at is REFUSED — 409
// CATH_LAB_READINESS_CASE_STARTED, the same code the order-missing and
// outside-result paths answer with. This is the MORE-restrictive direction and
// it is NOT the mirror image of the first. A lift re-resolves the item from the
// patient's own evidence, which may be none: the item regresses to missing and
// the `labs` check row regresses pass → pending, while recomputeCaseStatusTx
// leaves an `in_progress` case status alone. So the case status does not move,
// and the unmoving status HIDES the regression rather than making it safe — a
// mis-tap with the patient on the table flips a running case's checklist and
// nothing on the board says so.
//
// The asymmetry is clinical intent, not an oversight (owner decision
// 2026-09-06, confirmed to the merge authority: record-yes / lift-no). Do not
// "tidy" it into symmetry in either direction.
//
// Both routes decide from the case row they have ALREADY LOCKED, so neither the
// mark nor the refusal can be made against a case a concurrent writer starts
// underneath it.

// The waive side's marker. The write's own instant is NOW(), so "after start"
// is just whether the locked row already carried a start that has passed. A row
// that carries an UNPARSEABLE start still counts as started: a non-null
// actual_start_at is what "the procedure has started" means everywhere else in
// this feature.
function isAfterCaseStart(cathCase, at = Date.now()) {
  const startedAt = cathCase?.actual_start_at;
  if (!startedAt) return false;
  const startedMs = toMs(startedAt);
  return Number.isFinite(startedMs) ? startedMs <= at : true;
}

export async function waiveLabItem(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  const reason = cleanText(input.reason, 500);
  if (!reason) {
    throw AppError.badRequest(
      'reason is required to waive a lab item',
      'CATH_LAB_READINESS_VALUE_INVALID',
    );
  }
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    const recordedAfterStart = isAfterCaseStart(cathCase);
    await tx.$executeRawUnsafe(
      `INSERT INTO cath_case_lab_readiness_items
         (tenant_id, case_id, item_code, required, state, source,
          waived_by, waived_at, waive_reason, refreshed_at)
       VALUES ($1::uuid, $2::bigint, $3, TRUE, 'waived', 'waiver', $4::uuid, NOW(), $5, NOW())
       ON CONFLICT (tenant_id, case_id, item_code) DO UPDATE SET
         state = 'waived',
         source = 'waiver',
         waived_by = EXCLUDED.waived_by,
         waived_at = NOW(),
         waive_reason = EXCLUDED.waive_reason,
         refreshed_at = NOW()`,
      tid, cathCase.id, item, actor, reason,
    );
    await recordReadinessAudit(tx, {
      tenantId: tid,
      action: 'cath_lab.readiness.labs.item_waived',
      resource: 'cath_case_lab_readiness_items',
      resourceId: `${cathCase.id}:${item}`,
      context,
      // recorded_after_start is the whole of what the removed refusal used to
      // say, kept as a FACT on the trail instead of as a gate: a waiver written
      // while the patient was on the table is a real clinical decision and a
      // documented-late one, and the log has to be able to tell them apart. The
      // same boolean reaches the ward on the item itself, derived rather than
      // stored.
      //
      // Both readings take the start off the LOCKED case row, but they date the
      // waive differently — this one against the process clock as the statement
      // runs, the item's twin against waived_at, which is this transaction's own
      // NOW() (= transaction_timestamp(), taken when the transaction STARTED) — so
      // at the boundary where a start commits while this transaction is already
      // open the two can disagree, with the twin reading false; see
      // waivedAfterStart in cathLabReadinessRules.js.
      metadata: {
        case_id: cathCase.id, item, reason, recorded_after_start: recordedAfterStart,
      },
    });
    return refreshCaseLabReadiness({ tenantId: tid, caseId: cathCase.id, db: tx, context });
  });
}

// Lifting a waiver. The gate is not "undo": the waiver row and its audit trail
// stay in the log, and this writes a SECOND decision over them — the item goes
// back to being resolved from the patient's own lab evidence, which may leave
// it missing again and take the check off pass. That regression is exactly why
// this route, alone of the two, stays closed after actual_start_at; the block
// above waiveLabItem carries the reasoning.
//
// The state is not GUESSED here. Clearing the three waiver columns and running
// the refresh on the SAME transaction is what re-resolves the item, so a
// lifted waiver reads exactly what it would have read had it never been
// waived — including the value that was already on the row, which
// resolveItemState keeps on a waived item. `state` and `source` are set to the
// no-evidence pair rather than left saying `waived`, because migration 766's
// cath_case_lab_readiness_items_waiver_check refuses a `waived` row without a
// who/when/why the statement has just nulled; the refresh below overwrites
// both from the evidence a statement later.
export async function unwaiveLabItem(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  // Optional: WHY the waiver is being lifted. A waiver needs a reason because
  // it clears a gate; lifting one restores the gate, so it is the restrictive
  // direction and is not held up for prose.
  const reason = cleanText(input.reason, 500);
  requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    // The refusal half of the asymmetry documented above the waive path: a lift
    // regresses the item and the check while the case status stands still, so
    // it is closed once the patient is on the table. Decided from the LOCKED
    // row and raised before any write — a refusal that has already cleared the
    // waiver columns is the failure this guard exists to prevent.
    if (cathCase?.actual_start_at) {
      throw AppError.conflict(
        'The procedure has started; a waiver may be recorded but no longer lifted',
        'CATH_LAB_READINESS_CASE_STARTED',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT state, waive_reason
         FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND item_code = $3
        FOR UPDATE`,
      tid, cathCase.id, item,
    );
    const stored = rows[0] || null;
    // Read under the case lock and asserted from the STORED row, not from what
    // the caller believes: a second tap that arrives after the first has
    // already lifted the waiver is told so rather than writing a no-op audit
    // row saying a waiver was removed.
    if (!stored || String(stored.state) !== 'waived') {
      throw AppError.conflict(
        `The ${item} item is not waived`,
        'CATH_LAB_READINESS_NOT_WAIVED',
      );
    }
    const previousReason = stored.waive_reason ?? null;
    await tx.$executeRawUnsafe(
      `UPDATE cath_case_lab_readiness_items
          SET state = 'not_ordered',
              source = NULL,
              waived_by = NULL,
              waived_at = NULL,
              waive_reason = NULL,
              refreshed_at = NOW()
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND item_code = $3`,
      tid, cathCase.id, item,
    );
    await recordReadinessAudit(tx, {
      tenantId: tid,
      action: 'cath_lab.readiness.labs.unwaived',
      resource: 'cath_case_lab_readiness_items',
      resourceId: `${cathCase.id}:${item}`,
      context,
      // The reason the waiver GAVE is the thing being withdrawn, so it is
      // carried onto the row that withdraws it: the log otherwise says an
      // override was lifted without saying which override.
      //
      // There is deliberately no lifted_after_start twin of the waive path's
      // recorded_after_start: the guard above means a lift can only ever happen
      // before the start, so the field could only ever read false. A constant
      // on an audit row is not provenance, it is noise a later reader would
      // mistake for a fact that varies.
      metadata: {
        case_id: cathCase.id,
        item,
        reason,
        previous_reason: previousReason,
      },
    });
    return refreshCaseLabReadiness({ tenantId: tid, caseId: cathCase.id, db: tx, context });
  });
}

// Catalogue display names for the six orderable codes (migration 102). The
// codes themselves come from labAnalyteCodes.orderCodesCovering, which stays
// the single source of truth for WHICH orders cover which items.
const CATALOGUE_TEST_NAMES = Object.freeze({
  CBC: 'Complete Blood Count',
  PLT: 'Platelet Count',
  CREATININE: 'Serum Creatinine',
  KFT: 'Kidney Function Test',
  ELECTROLYTES: 'Serum Electrolytes',
  HIV: 'HIV 1 & 2 Antibody (ELISA)',
  HBSAG: 'Hepatitis B Surface Antigen',
  HCV: 'Hepatitis C Antibody',
});

// cath_lab_cases.urgency (elective | routine | urgent | emergency — the
// vocabulary cathLabService.createCase normalises to) mapped onto the priority
// vocabulary createInvestigationOrder accepts (PRIORITY_LEVELS in
// config/investigationConfig.js: STAT | URGENT | HIGH | NORMAL | LOW). A
// primary-PCI patient's pre-procedure bloods must not sit on the lab worklist
// behind an elective case's on a 24-hour turnaround clock: STAT is a 1-hour
// target, URGENT 4. Anything unrecognised falls back to NORMAL, which is the
// value this path used unconditionally before.
const CATH_URGENCY_ORDER_PRIORITY = Object.freeze({
  emergency: 'STAT',
  urgent: 'URGENT',
  routine: 'NORMAL',
  elective: 'NORMAL',
});

export function orderPriorityForUrgency(urgency) {
  return CATH_URGENCY_ORDER_PRIORITY[String(urgency ?? '').trim().toLowerCase()] || 'NORMAL';
}

export async function orderMissingLabs(caseId, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const actor = requireUuid(context.actorUid, 'actorUid');
  const before = await refreshCaseLabReadiness({ tenantId: tid, caseId, context });
  if (before.case_started) {
    throw AppError.conflict(
      'The procedure has started; order labs from the case instead',
      'CATH_LAB_READINESS_CASE_STARTED',
    );
  }
  const codes = before.orderable_now.filter((code) => !before.open_order_codes.includes(code));
  const patientRows = await setTenant(tid, (client) => client.$queryRawUnsafe(
    `SELECT u.id, c.urgency
       FROM users u
       JOIN cath_lab_cases c
         ON c.patient_uid = u.uid
        AND c.tenant_id = u.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::bigint
      LIMIT 1`,
    tid, positiveInt(caseId, 'case_id'),
  ));
  if (!patientRows[0]) {
    throw AppError.notFound('Cath-lab case patient not found', 'CATH_LAB_CASE_NOT_FOUND');
  }
  const created = [];
  const skipped = before.orderable_now
    .filter((code) => before.open_order_codes.includes(code))
    .map((code) => ({ code, reason: 'already_ordered' }));
  const priority = orderPriorityForUrgency(patientRows[0].urgency);
  for (const code of codes) {
    try {
      // createInvestigationOrder returns { investigation, patient_name,
      // duplicate_warning } — the order row is one level in, not the return.
      const order = await createInvestigationOrder({
        patient_id: Number(patientRows[0].id),
        doctor_uid: actor,
        orderedBy: actor,
        test_name: CATALOGUE_TEST_NAMES[code] || code,
        test_code: code,
        type: 'LAB',
        priority,
        notes: `Pre-cath lab readiness (case ${before.case_id})`,
        tenantId: tid,
        actorRole: context.actorRole || null,
      });
      created.push({ code, investigation_id: Number(order.investigation.id) });
    } catch (err) {
      // AppError.internal takes (message, code) and NOTHING else — a third
      // argument is silently dropped, which is how this error used to reach the
      // ward as a bare INTERNAL_ERROR. Constructed directly so both the code and
      // the partial progress survive: some orders may already be on the lab's
      // worklist, and re-running order-missing must not double them.
      throw new AppError(
        `Could not place the ${code} order: ${err?.code || err?.message}`,
        500,
        'CATH_LAB_READINESS_ORDER_FAILED',
        { code, cause: err?.code || null, created: created.map((row) => row.code) },
      );
    }
  }
  await setTenantTx(tid, (tx) => recordReadinessAudit(tx, {
    tenantId: tid,
    action: 'cath_lab.readiness.labs.orders_placed',
    resource: 'cath_lab_cases',
    resourceId: before.case_id,
    context,
    metadata: { created, skipped },
  }));
  const after = await refreshCaseLabReadiness({ tenantId: tid, caseId, context });
  return { created, skipped, readiness: after };
}

const QUALITATIVE_TOKENS = Object.freeze([
  'reactive', 'non-reactive', 'nonreactive', 'non reactive',
  'positive', 'negative', 'indeterminate', 'not detected', 'detected',
]);

// The fingerprint the ingest-command rail requires. An outside entry has no
// HTTP body of its own when it arrives through a service call, so the
// fingerprint is taken over the fields that define the result: the same value
// twice replays, a corrected value is a new command.
function externalEntryFingerprint(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export async function recordExternalLabResult(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  const def = LAB_ANALYTE_ITEMS[item];
  const actor = requireUuid(context.actorUid, 'actorUid');
  const labName = cleanText(input.external_lab_name, 160);
  const reportRef = cleanText(input.external_report_ref, 120);
  const notes = cleanText(input.notes, 2000);
  const observedOn = String(input.observed_on ?? '').trim();
  if (!labName) {
    throw AppError.badRequest('external_lab_name is required', 'CATH_LAB_READINESS_VALUE_INVALID');
  }
  // "Today" is the ward's today (Asia/Kolkata), not UTC's: between 18:30 and
  // midnight IST a same-day report is tomorrow in UTC and would be refused.
  // isCalendarDate, not the bare shape regex: 2026-13-45 is ten characters in
  // the right pattern and raises 22008 on the ::date cast further down, which
  // reaches the ward as a 500 rather than as the 400 it is.
  if (!isCalendarDate(observedOn) || observedOn > clinicalDate(new Date())) {
    throw AppError.badRequest(
      'observed_on must be a past or present date (YYYY-MM-DD)',
      'CATH_LAB_READINESS_VALUE_INVALID',
    );
  }
  const valueText = cleanText(input.value_text, 255);
  let valueNumeric = null;
  let unit = cleanText(input.unit, 40) || def.unit;
  if (def.kind === 'qualitative') {
    const token = String(valueText || '').toLowerCase();
    if (!QUALITATIVE_TOKENS.some((allowed) => token === allowed)) {
      throw AppError.badRequest(
        `value_text must be one of ${QUALITATIVE_TOKENS.join(', ')}`,
        'CATH_LAB_READINESS_VALUE_INVALID',
      );
    }
    unit = null;
  } else {
    // NOT `Number(input.value_numeric ?? valueText)`: that turns null, '', []
    // and false into 0 and true into 1, so a request naming no value at all was
    // stored as a creatinine of 0 — a value that reads as normal, passes the
    // gate and clears the case. Only an explicit finite number, or a plain
    // decimal string in either field, is a value.
    valueNumeric = externalNumericValue(input.value_numeric, valueText);
    if (!unit) {
      throw AppError.badRequest(
        'unit is required for a quantitative result',
        'CATH_LAB_READINESS_VALUE_INVALID',
      );
    }
  }
  const cathCase = await setTenant(tid, (client) => caseRowTx(client, tid, caseId));
  if (cathCase.actual_start_at) {
    throw AppError.conflict(
      'The procedure has started; outside results are recorded on the case, not the checklist',
      'CATH_LAB_READINESS_CASE_STARTED',
    );
  }

  // abnormal_flag is NOT computed here, and that is spec §8.2 honoured rather
  // than skipped: an outside numeric value must carry the same flag an in-house
  // one would, and on this platform lab_results.abnormal_flag is owned by the
  // GOVERNED threshold policy, not by whoever writes the row.
  // labThresholdExceptionService rewrites reference_range, reference_range_low /
  // _high and abnormal_flag from the policy assessment immediately after the
  // insert (and nulls them when no policy matches the analyte, leaving
  // criticality_status 'threshold_unavailable'). The panel path says the same
  // thing by inserting abnormal_flag: null outright. Deriving a flag here from
  // lab_reference_ranges would either be overwritten a statement later or, worse
  // where no policy matches, give an OUTSIDE value a flag the in-house value for
  // the same analyte does not carry — the exact inconsistency §8.2 exists to
  // prevent. The readiness item copies whatever the governed rail decided.

  const storedValue = def.kind === 'qualitative' ? valueText : String(valueNumeric);
  const fingerprint = SHA256_HEX.test(String(context.requestFingerprint || ''))
    ? String(context.requestFingerprint)
    : externalEntryFingerprint({
      case_id: cathCase.id,
      item,
      value: storedValue,
      unit,
      observed_on: observedOn,
      external_lab_name: labName,
      external_report_ref: reportRef,
    });
  // One Idempotency-Key, one lab command PER ITEM. The header names the
  // caller's REQUEST; the lab rail keys its command table on
  // (tenant_id, actor_uid, command_scope, command_key), so handing it the bare
  // header would make the SECOND item of an hiv/hbsag/hcv trio sent under one
  // key collide with the first and fail LAB_RESULT_COMMAND_BODY_MISMATCH (422)
  // — then serve that 422 back from the HTTP claim for the rest of the key's
  // life. Suffixing the item code makes different items distinct commands while
  // a genuine retry of the SAME item still replays (same key, same
  // fingerprint). The suffix is budgeted inside the rail's 200-character
  // command_key limit, so a caller key at the cap cannot push the joined key
  // over it. With no header the content-derived fallback already carries the
  // item.
  const callerKey = cleanText(context.idempotencyKey, Math.max(1, 199 - item.length));
  const idempotencyKey = callerKey
    ? `${callerKey}:${item}`
    : `cath-readiness-ext:${cathCase.id}:${item}:${fingerprint.slice(0, 32)}`;

  // recordExternalLabResultRow, NOT recordResultManual with a flag: the escape
  // is a separate entry point no route can reach, and this module is the only
  // permitted caller (pinned by tests/unit/labExternalResultCallSites.test.js).
  const recorded = await recordExternalLabResultRow({
    tenantId: tid,
    performed_by: actor,
    performed_by_role: context.actorRole || null,
    qualitative: def.kind === 'qualitative',
    result: {
      patient_uid: cathCase.patient_uid,
      test_code: def.canonicalAnalyteCode,
      test_name: `${def.canonicalAnalyteCode} (external lab)`,
      value_text: storedValue,
      unit,
      comments: notes,
      result_origin: 'external_lab',
      external_lab_name: labName,
      external_report_ref: reportRef,
      external_reported_on: observedOn,
      performed_at: `${observedOn}T00:00:00+05:30`,
    },
  }, {
    idempotencyKey,
    requestBodySha256: fingerprint,
    httpIdempotencyClaimId: context.httpIdempotencyClaimId || null,
    requestId: context.requestId || null,
  });
  const labResult = recorded.result;

  // Serology also lands on the patient's blood-borne marker record (Plan 1's
  // rail), so the reuse resolver and the cath capture sheet see the outside
  // value too. `external_report` markers must carry the lab link.
  if (def.marker) {
    await recordMarkers({
      tenantId: tid,
      patientUid: cathCase.patient_uid,
      actorUid: actor,
      entries: [{
        marker: def.marker,
        result: normalizeSerologyValue(valueText),
        tested_on: observedOn,
        source: 'external_report',
        lab_result_id: Number(labResult.id),
        evidence: {
          external_lab_name: labName,
          external_report_ref: reportRef,
          raw_value: valueText,
        },
      }],
    });
  }
  await setTenantTx(tid, (tx) => recordReadinessAudit(tx, {
    tenantId: tid,
    action: 'CATH_LAB_EXTERNAL_RESULT_RECORDED',
    resource: 'lab_results',
    resourceId: Number(labResult.id),
    context,
    metadata: {
      case_id: cathCase.id,
      item,
      external_lab_name: labName,
      external_report_ref: reportRef,
      observed_on: observedOn,
    },
  }));
  const readiness = await refreshCaseLabReadiness({
    tenantId: tid, caseId: cathCase.id, context,
  });
  return { lab_result_id: Number(labResult.id), item, readiness };
}
