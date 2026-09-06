// apps/backend/src/services/clinical/cathLabReadinessService.js
//
// Pre-procedure lab readiness for cath cases: the PERSISTENCE half — tenant
// settings, the refresh that resolves the seven items and writes them, and the
// check-level automation over them. Spec:
// docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
//
// Seven items under the existing `labs` readiness check, resolved from
// lab_results, open investigations/bookings and lab_specimens. Automation
// passes the check on availability and flips it back only if it set it; a
// critical value warns and never blocks (owner decision).
//
// WHERE THE REST OF IT LIVES. This file used to be all three halves at once:
//
//   * cathLabReadinessRules.js   — the pure vocabulary, `resolveItemState` and
//     `computeCheckDecision`. No I/O, no clock, no tenant, so the behaviour the
//     whole feature turns on can be driven directly.
//   * cathLabReadinessActions.js — waive, un-waive, order-missing and the
//     outside-result entry: the four writes, and the only code here that
//     reaches orderService, labResultsService and the marker rail.
//   * cathParamGuards.js         — requireUuid / positiveInt / cleanText / num
//     / tenantOr / withTenant, shared by all three.
//
// THIS FILE IS ALSO THE FACADE: it re-exports every name from all three, so
// every existing `from './cathLabReadinessService.js'` — the routes,
// cathLabService, the deep suite, the unit suites and the OpenAPI source pin —
// keeps working unchanged. New code may import the narrower module directly.
//
// Cycles. cathLabReadinessActions.js imports caseRowTx, recordReadinessAudit
// and refreshCaseLabReadiness from HERE while this file re-exports it: a
// deliberate ES-module cycle, safe because all three are hoisted `function`
// declarations and neither module calls the other during evaluation.
// labResultsService reaches the refresh only through a DYNAMIC import of
// refreshOpenCasesForPatient, never a static one, and orderService does not
// reach back at all. cathLabService imports this module for getCase, so this
// module must not import cathLabService — which is why the readiness gate
// recompute is inlined below (recomputeCaseStatusTx) rather than borrowed from
// cathLabService.evaluateReadinessGate.

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { BLOODBORNE_MARKER_ITEM_CODES, orderCodesCovering } from '../lab/labAnalyteCodes.js';
import {
  DEFAULT_SEROLOGY_VALIDITY_DAYS,
  ITEM_CODES,
  OPEN_ORDER_STATUSES_EXCLUDED,
  SETTINGS_DEFAULTS,
  computeCheckDecision,
  instantMs,
  msToIso,
  orderCoversItem,
  pendingReasonFor,
  resolveItemState,
  toMs,
  withinWindow,
} from './cathLabReadinessRules.js';
import {
  cleanText,
  num,
  positiveInt,
  requireUuid,
  tenantOr,
  withTenant,
} from './cathParamGuards.js';

// ---------------------------------------------------------------------------
// Small helpers that belong to the WRITE path
//
// int4OrNull and deepEqual are about what may be bound to this module's own
// columns and about whether a stored jsonb already says what the refresh is
// about to write. Neither is a rule and neither is a parameter guard, so both
// stay here with the statements they exist for.
// ---------------------------------------------------------------------------

const POSTGRES_INT4_MAX = 2_147_483_647;

// A lab_results / investigations / lab_specimens id copied onto a readiness
// item. These columns are int4 in both directions; a value that would not
// survive the ::int cast is dropped rather than bound, because the pointer is
// an optimisation (the refresh recomputes the item regardless) and a 22003 in
// the middle of a cath-case read is not.
function int4OrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > POSTGRES_INT4_MAX) return null;
  return n;
}

// Structural equality for the JSON the check row already carries. Key ORDER is
// not compared: `metadata` comes back out of jsonb, which does not preserve the
// order the object was written in, so JSON.stringify on both sides would report
// every read as a change and defeat the write-once rule below.
function deepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, i) => deepEqual(item, right[i]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

// audit_logs shape mirrors cssdService.js:208 — (tenant_id, uid, role, action,
// resource, resource_id, metadata, actor_uid, created_at). `role` is
// VARCHAR(50) and `action`/`resource`/`resource_id` are VARCHAR(100).
export async function recordReadinessAudit(tx, {
  tenantId, action, resource, resourceId, context = {}, metadata = {},
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null,
    cleanText(context.actorRole, 50),
    cleanText(action, 100),
    cleanText(resource, 100),
    cleanText(String(resourceId), 100),
    JSON.stringify(metadata ?? {}),
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_SELECT = 'tenant_id, required_items, lab_validity_days, auto_pass, '
  + 'external_results_count, updated_by, created_at, updated_at';

export async function getReadinessSettings({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${SETTINGS_SELECT}
       FROM cath_lab_readiness_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tid,
  ));
  const row = rows[0];
  if (!row) {
    return {
      tenant_id: tid,
      ...SETTINGS_DEFAULTS,
      required_items: [...SETTINGS_DEFAULTS.required_items],
      configured: false,
    };
  }
  return {
    ...row,
    lab_validity_days: Number(row.lab_validity_days),
    required_items: Array.isArray(row.required_items) ? row.required_items : [],
    configured: true,
  };
}

export async function upsertReadinessSettings(input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const supplied = Array.isArray(input.required_items)
    ? input.required_items.map((code) => String(code ?? '').trim().toLowerCase())
    : null;
  // An explicitly empty set is a 400, not a database error: migration 766's
  // cath_lab_readiness_settings_items_check requires at least one item, and a
  // 23514 surfacing as a 500 tells the tenant administrator nothing.
  if (supplied && supplied.length === 0) {
    throw AppError.badRequest(
      'required_items must name at least one item; mark the labs check not required on the case instead',
      'CATH_LAB_READINESS_ITEMS_EMPTY',
    );
  }
  const requiredItems = [...new Set(supplied ?? [...SETTINGS_DEFAULTS.required_items])];
  if (requiredItems.some((code) => !ITEM_CODES.includes(code))) {
    throw AppError.badRequest(
      `required_items must be within ${ITEM_CODES.join(', ')}`,
      'CATH_LAB_READINESS_ITEM_UNKNOWN',
    );
  }
  const validity = positiveInt(
    input.lab_validity_days ?? SETTINGS_DEFAULTS.lab_validity_days,
    'lab_validity_days',
    365,
  );
  const autoPass = input.auto_pass === undefined ? true : Boolean(input.auto_pass);
  const externalCount = input.external_results_count === undefined
    ? true
    : Boolean(input.external_results_count);
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_readiness_settings
         (tenant_id, required_items, lab_validity_days, auto_pass, external_results_count, updated_by)
       VALUES ($1::uuid, $2::text[], $3::int, $4::boolean, $5::boolean, $6::uuid)
       ON CONFLICT (tenant_id) DO UPDATE SET
         required_items = EXCLUDED.required_items,
         lab_validity_days = EXCLUDED.lab_validity_days,
         auto_pass = EXCLUDED.auto_pass,
         external_results_count = EXCLUDED.external_results_count,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING ${SETTINGS_SELECT}`,
      tid, requiredItems, validity, autoPass, externalCount, actor,
    );
    await recordReadinessAudit(tx, {
      tenantId: tid,
      action: 'CATH_LAB_READINESS_SETTINGS_UPDATED',
      resource: 'cath_lab_readiness_settings',
      resourceId: tid,
      context,
      metadata: {
        required_items: requiredItems,
        lab_validity_days: validity,
        auto_pass: autoPass,
        external_results_count: externalCount,
      },
    });
    return {
      ...rows[0],
      lab_validity_days: Number(rows[0].lab_validity_days),
      configured: true,
    };
  });
}

// The serology window is the reuse programme's (migration 765), not a second
// number this feature invents: a tenant that shortened HIV/HBsAg/HCV validity
// for device reuse means the same thing here. A tenant that has never saved one
// falls back to the compiled-in default.
//
// No 42P01 guard: migration 765 creates cath_reprocessing_settings and ships in
// this same branch, so the table is always there — and a 42P01 raised inside the
// refresh transaction has already aborted it, so catching it here would only
// swap the honest error for a 25P02 on the next statement.
async function serologyValidityDays(tenantId, db) {
  const rows = await db.$queryRawUnsafe(
    `SELECT serology_validity_days
       FROM cath_reprocessing_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return rows[0] ? Number(rows[0].serology_validity_days) : DEFAULT_SEROLOGY_VALIDITY_DAYS;
}

// ---------------------------------------------------------------------------
// Refresh: resolve the seven items, persist them, apply the check-level rule
// ---------------------------------------------------------------------------

// `lock`: false, true, 'update' or 'no key update'. Identifier-free — the
// clause is chosen from this closed map, never interpolated from an argument.
//
// `true` is the accepted shorthand for 'update', and it is what waiveLabItem
// and unwaiveLabItem actually pass: any truthy value that is not a key of the
// map falls through the `??` below to FOR UPDATE, which is the RESTRICTIVE
// default. Documented rather than tightened — the fallback is what makes a
// typo'd lock name take the strongest lock instead of silently taking none,
// and the two waiver writes rely on `true` meaning exactly FOR UPDATE.
const CASE_LOCK_CLAUSES = Object.freeze({
  update: 'FOR UPDATE',
  // The refresh's lock. It still conflicts with the FOR UPDATE every other cath
  // writer takes on the case row, so two refreshes and a writer still serialise
  // — but it does NOT conflict with the FOR KEY SHARE that a child-row insert
  // (a readiness item, a consumable, a device link) takes on the parent, so a
  // read-driven refresh no longer parks writers behind it.
  'no key update': 'FOR NO KEY UPDATE',
});

export async function caseRowTx(client, tenantId, caseId, { lock = false } = {}) {
  const lockClause = lock ? (CASE_LOCK_CLAUSES[lock] ?? CASE_LOCK_CLAUSES.update) : '';
  const rows = await client.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, urgency, actual_start_at
       FROM cath_lab_cases
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      ${lockClause}
      LIMIT 1`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return { ...row, id: num(row.id) };
}

// Exactly what the UPSERT below binds, in one object, so the STORED row can be
// compared against it column for column and an unchanged item skipped. The
// widths mirror the lab_results columns migration 766 copies from. Exported so
// the bound SHAPES can be pinned without a database: every column below is cast
// in SQL, and which JS type reaches that cast is the whole question.
export function itemWriteValues(item) {
  return {
    required: item.required !== false,
    state: item.state,
    // The copy targets mirror the lab_results widths (255 / 40 / 10); clamp
    // rather than let a widened source column raise 22001 inside a case read.
    value_text: cleanText(item.value_text, 255),
    value_numeric: item.value_numeric == null ? null : Number(item.value_numeric),
    unit: cleanText(item.unit, 40),
    abnormal_flag: cleanText(item.abnormal_flag, 10),
    is_critical: Boolean(item.is_critical),
    observed_at: item.observed_at ?? null,
    source: item.source ?? null,
    lab_result_id: int4OrNull(item.lab_result_id),
    investigation_id: int4OrNull(item.investigation_id),
    specimen_id: int4OrNull(item.specimen_id),
    ordered_at: item.ordered_at ?? null,
    waived_by: item.waived_by ? requireUuid(item.waived_by, 'waived_by') : null,
    // The one instant here that does not already arrive as an ISO string: a
    // waiver is read back off the STORED row, so the driver hands it over as a
    // Date. Binding that Date is the Prisma 7 session-timezone skew this module
    // writes instants as strings to avoid, so it is normalised to the shape
    // observed_at and ordered_at already carry (msToIso). storedItemMatches
    // compares both sides through toMs, so the round trip still reads equal and
    // a waived item is still not rewritten by a no-op refresh. A value that is
    // not an instant at all is passed through untouched: resolveItemState has
    // already refused a waived item without one, so this is the corrupt-row
    // path, and nulling it would trade migration 766's waiver CHECK for a
    // silent loss of who waived and when.
    waived_at: msToIso(toMs(item.waived_at)) ?? item.waived_at ?? null,
    waive_reason: item.waive_reason ?? null,
  };
}

const ITEM_TEXT_COLUMNS = Object.freeze([
  'state', 'value_text', 'unit', 'abnormal_flag', 'source', 'waive_reason',
]);
const ITEM_INT_COLUMNS = Object.freeze(['lab_result_id', 'investigation_id', 'specimen_id']);
const ITEM_INSTANT_COLUMNS = Object.freeze(['observed_at', 'ordered_at', 'waived_at']);

// Does the stored row already say exactly what the computed item says? Compared
// per column TYPE rather than with ===: the driver hands a NUMERIC back as a
// Decimal or a string and a TIMESTAMPTZ back as a Date, while the computed item
// carries a JS number and an ISO string. refreshed_at is deliberately excluded —
// it is the write's own timestamp, not evidence, and comparing it would make
// every row differ from itself.
function storedItemMatches(stored, values) {
  if (!stored) return false;
  if (Boolean(stored.required) !== values.required) return false;
  if (Boolean(stored.is_critical) !== values.is_critical) return false;
  for (const column of ITEM_TEXT_COLUMNS) {
    const left = stored[column] == null ? null : String(stored[column]);
    if (left !== values[column]) return false;
  }
  for (const column of ITEM_INT_COLUMNS) {
    const left = stored[column] == null ? null : Number(stored[column]);
    if (left !== values[column]) return false;
  }
  for (const column of ITEM_INSTANT_COLUMNS) {
    const left = stored[column] == null ? null : toMs(stored[column]);
    const right = values[column] == null ? null : toMs(values[column]);
    if (left !== right) return false;
  }
  const storedNumeric = stored.value_numeric == null ? null : Number(stored.value_numeric);
  if (storedNumeric !== values.value_numeric) return false;
  const storedWaivedBy = stored.waived_by == null ? null : String(stored.waived_by).toLowerCase();
  return storedWaivedBy === values.waived_by;
}

const STORED_ITEM_SELECT = 'item_code, required, state, value_text, value_numeric, unit, '
  + 'abnormal_flag, is_critical, observed_at, source, lab_result_id, investigation_id, '
  + 'specimen_id, ordered_at, waived_by, waived_at, waive_reason, refreshed_at';

async function upsertItemTx(tx, tenantId, caseId, itemCode, values) {
  await tx.$executeRawUnsafe(
    `INSERT INTO cath_case_lab_readiness_items
       (tenant_id, case_id, item_code, required, state, value_text, value_numeric, unit,
        abnormal_flag, is_critical, observed_at, source, lab_result_id, investigation_id,
        specimen_id, ordered_at, waived_by, waived_at, waive_reason, refreshed_at)
     VALUES ($1::uuid, $2::bigint, $3, $4::boolean, $5, $6, $7::numeric, $8,
             $9, $10::boolean, $11::timestamptz, $12, $13::int, $14::int,
             $15::int, $16::timestamptz, $17::uuid, $18::timestamptz, $19, NOW())
     ON CONFLICT (tenant_id, case_id, item_code) DO UPDATE SET
       required = EXCLUDED.required,
       state = EXCLUDED.state,
       value_text = EXCLUDED.value_text,
       value_numeric = EXCLUDED.value_numeric,
       unit = EXCLUDED.unit,
       abnormal_flag = EXCLUDED.abnormal_flag,
       is_critical = EXCLUDED.is_critical,
       observed_at = EXCLUDED.observed_at,
       source = EXCLUDED.source,
       lab_result_id = EXCLUDED.lab_result_id,
       investigation_id = EXCLUDED.investigation_id,
       specimen_id = EXCLUDED.specimen_id,
       ordered_at = EXCLUDED.ordered_at,
       waived_by = EXCLUDED.waived_by,
       waived_at = EXCLUDED.waived_at,
       waive_reason = EXCLUDED.waive_reason,
       refreshed_at = NOW()`,
    tenantId,
    caseId,
    itemCode,
    values.required,
    values.state,
    values.value_text,
    values.value_numeric,
    values.unit,
    values.abnormal_flag,
    values.is_critical,
    values.observed_at,
    values.source,
    values.lab_result_id,
    values.investigation_id,
    values.specimen_id,
    values.ordered_at,
    values.waived_by,
    values.waived_at,
    values.waive_reason,
  );
}

// The same gate as cathLabService.evaluateReadinessGate, inlined: cathLabService
// imports this module for getCase, so importing it back would be a static cycle.
const READINESS_CHECK_TYPES = Object.freeze([
  'consent', 'labs', 'allergy_renal_risk', 'anticoagulation',
  'blood_bank', 'equipment', 'implants_device_rep', 'timeout',
]);
const READINESS_CLEAR_STATES = new Set(['pass', 'waived', 'not_applicable']);

async function recomputeCaseStatusTx(tx, tenantId, caseId, actorUid) {
  const checks = await tx.$queryRawUnsafe(
    `SELECT check_type, status, required
       FROM cath_lab_readiness_checks
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint`,
    tenantId, caseId,
  );
  const byType = new Map(checks.map((check) => [check.check_type, check]));
  const ready = READINESS_CHECK_TYPES.every((type) => {
    const check = byType.get(type);
    return Boolean(check) && (check.required === false || READINESS_CLEAR_STATES.has(check.status));
  });
  await tx.$executeRawUnsafe(
    `UPDATE cath_lab_cases
        SET status = CASE
              WHEN status IN ('scheduled', 'readiness_pending', 'ready') THEN $3
              ELSE status
            END,
            updated_by = COALESCE($4::uuid, updated_by),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    tenantId, caseId, ready ? 'ready' : 'readiness_pending', actorUid,
  );
  return ready;
}

// Booking statuses a draw can still happen under. Migration 098 puts no CHECK
// on investigation_bookings.status, so the vocabulary is the lifecycle its own
// header documents — BOOKED → CONFIRMED → DISPATCHED → COLLECTED → PROCESSING →
// RESULT_READY — plus CANCELLED and the NO_SHOW-shaped terminals a lab adds.
// This is the SAME resultable set labResultsService, labPanelService and
// labClosedLoopService already use, and it deliberately excludes every terminal
// one: CANCELLED / NO_SHOW (nothing will be drawn) and RESULT_READY (the value
// is in, so the lab_results row is the evidence from then on, not the booking).
const RESULTABLE_BOOKING_STATUSES = Object.freeze([
  'BOOKED', 'CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING',
]);

// How long the `labs` check row's live_evidence stamp may go unrefreshed before
// the refresh writes it again even though nothing about the evidence changed.
// A read-driven refresh runs on every GET of the case; without this the row
// would be rewritten (metadata included, ~3 KB of it) on every one of them.
const EVIDENCE_STAMP_MAX_AGE_MS = 60_000;

export async function refreshCaseLabReadiness({
  tenantId, caseId, db = null, context = {},
} = {}) {
  const tid = tenantOr(tenantId);
  const run = db ? (fn) => fn(db) : (fn) => setTenantTx(tid, fn);
  return run(async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: 'no key update' });
    const settings = await getReadinessSettings({ tenantId: tid, db: tx });
    const serologyDays = await serologyValidityDays(tid, tx);
    const asOf = new Date();
    // Serology carries the reuse programme's window; everything else the
    // tenant's lab validity. One function, so the item resolution, the
    // open-order set and the orderable set cannot drift apart.
    const windowDaysFor = (code) => (BLOODBORNE_MARKER_ITEM_CODES.includes(code)
      ? serologyDays
      : settings.lab_validity_days);
    // Wide enough that a value which has merely gone stale is still SEEN — the
    // resolver needs the row to answer 'stale' rather than 'not_ordered'.
    const lookbackDays = Math.max(settings.lab_validity_days, serologyDays) + 365;

    // lab_results.received_at is NOT NULL, so COALESCE(performed_at,
    // received_at) is always a real instant: nothing is silently dropped here.
    //
    // The three _epoch_ms twins are the house rule for an instant the resolver
    // compares against the process clock (src/utils/dbInstant.js): the pg driver
    // materialises a TIMESTAMPTZ in the DATABASE SESSION timezone, the twin is
    // the absolute instant in every session. external_reported_on is a DATE —
    // no zone to shift, and it is the day the outside laboratory reported the
    // value, which is what freshness must be measured from.
    const results = await tx.$queryRawUnsafe(
      `SELECT id, test_code, loinc_code, value_text, value_numeric, unit, abnormal_flag,
              is_critical, status, signed_off_at, performed_at, received_at, result_origin,
              external_reported_on,
              (EXTRACT(EPOCH FROM signed_off_at) * 1000)::bigint AS signed_off_at_epoch_ms,
              (EXTRACT(EPOCH FROM performed_at) * 1000)::bigint AS performed_at_epoch_ms,
              (EXTRACT(EPOCH FROM received_at) * 1000)::bigint AS received_at_epoch_ms
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND COALESCE(performed_at, received_at) >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays,
    );
    // investigations.status is the UPPER-case lifecycle from
    // config/investigationConfig.js (REQUESTED → SCHEDULED → COLLECTED →
    // IN_PROGRESS → COMPLETED, plus CANCELLED); the column carries no CHECK.
    //
    // requested_at is TIMESTAMP WITHOUT TIME ZONE (collected_at is TIMESTAMPTZ),
    // so its stored value only means something once you say which zone wrote it.
    // Every app writer goes through Prisma, whose sessions are pinned to UTC
    // (pinSessionTimeZoneToUrl in src/lib/prisma.js), so the naive value is a
    // UTC wall clock and `AT TIME ZONE 'UTC'` is what turns it back into the
    // instant. Spelled out rather than left to EXTRACT's implicit
    // treat-naive-as-UTC rule, so the assumption is visible where it is made.
    const investigationOrders = await tx.$queryRawUnsafe(
      `SELECT i.id, i.test_code, i.status, i.requested_at, i.collected_at, b.id AS booking_id,
              (EXTRACT(EPOCH FROM (i.requested_at AT TIME ZONE 'UTC')) * 1000)::bigint
                AS requested_at_epoch_ms,
              (EXTRACT(EPOCH FROM i.collected_at) * 1000)::bigint AS collected_at_epoch_ms
         FROM investigations i
         LEFT JOIN investigation_bookings b
           ON b.investigation_id = i.id
          AND b.tenant_id = i.tenant_id
        WHERE i.tenant_id = $1::uuid
          AND i.patient_uid = $2::uuid
          AND i.status NOT IN ('COMPLETED', 'CANCELLED')
          AND i.requested_at >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays,
    );
    // Spec §7 step 2: a patient-app booking is an order too. Its tests are
    // catalogue IDS in investigation_bookings.selected_tests (migration 098),
    // and a booking that has not been turned into an investigations row yet —
    // investigation_id IS NULL — is exactly what the query above cannot see.
    // Without this the checklist tells the ward to order a draw that is
    // already booked, and order-missing places a duplicate.
    //
    // ordered_at is the booking's created_at: when the order was PLACED, which
    // is what investigations.requested_at means and what the freshness window
    // is measured from. scheduled_date is a DATE with no time and is often
    // null, so it cannot carry that meaning. created_at is TIMESTAMP WITHOUT
    // TIME ZONE and is read back as UTC for the same reason requested_at is.
    // investigation_bookings has no patient_uid, so the patient is resolved
    // through users.id the way every other booking reader does; the catalogue
    // is global (no tenant_id) and joins on its own code column.
    const resultableBookingStatuses = [...RESULTABLE_BOOKING_STATUSES];
    const bookingOrders = await tx.$queryRawUnsafe(
      `SELECT NULL::int AS id, UPPER(cat.code) AS test_code, b.status,
              b.created_at AS requested_at, b.collected_at, b.id AS booking_id,
              (EXTRACT(EPOCH FROM (b.created_at AT TIME ZONE 'UTC')) * 1000)::bigint
                AS requested_at_epoch_ms,
              (EXTRACT(EPOCH FROM b.collected_at) * 1000)::bigint AS collected_at_epoch_ms
         FROM investigation_bookings b
         JOIN users u
           ON u.id = b.patient_id
          AND u.tenant_id = b.tenant_id
         CROSS JOIN LATERAL unnest(b.selected_tests) AS selected(catalog_id)
         JOIN investigation_test_catalog cat
           ON cat.id = selected.catalog_id
        WHERE b.tenant_id = $1::uuid
          AND u.uid = $2::uuid
          AND b.investigation_id IS NULL
          AND UPPER(b.status) = ANY($4::text[])
          AND cat.code IS NOT NULL
          AND b.created_at >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays, resultableBookingStatuses,
    );
    const orders = [...investigationOrders, ...bookingOrders];
    const bookingIds = [...new Set(
      orders.map((order) => int4OrNull(order.booking_id)).filter((id) => id != null),
    )];
    // lab_specimens.status is the LOWER-case vocabulary of
    // lab_specimens_status_check (ordered/collected/in_transit/received/
    // processing/rejected/disposed/cancelled).
    const specimens = bookingIds.length
      ? await tx.$queryRawUnsafe(
        `SELECT id, booking_id, status
           FROM lab_specimens
          WHERE tenant_id = $1::uuid
            AND booking_id = ANY($2::int[])
          ORDER BY id DESC`,
        tid, bookingIds,
      )
      : [];
    // The seven persisted rows, read ONCE. They are both the waiver source (a
    // waiver lives on the item row it waives) and the baseline the write-once
    // rule below compares against, so a second query for either would be a
    // second chance for the two reads to disagree.
    const storedRows = await tx.$queryRawUnsafe(
      `SELECT ${STORED_ITEM_SELECT}
         FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint`,
      tid, cathCase.id,
    );
    const storedByCode = new Map(storedRows.map((row) => [row.item_code, row]));

    const items = ITEM_CODES.map((code) => {
      const stored = storedByCode.get(code) || null;
      const waiver = stored && stored.state === 'waived' ? stored : null;
      return {
        ...resolveItemState({
          item: code,
          results,
          orders,
          specimens,
          waiver,
          windowDays: windowDaysFor(code),
          asOf,
          // Drives the waiver-lateness marker (`recorded_after_start`) and
          // nothing else. It is the LOCKED case row's own column, so the marker
          // and `case_started` below can never disagree about the same case.
          caseStartedAt: cathCase.actual_start_at,
        }),
        required: settings.required_items.includes(code),
      };
    });
    // Write only what changed. A cath case is READ far more often than its labs
    // move, and every read used to rewrite all seven rows — churning
    // refreshed_at, the row versions and the WAL for nothing.
    for (const item of items) {
      const values = itemWriteValues(item);
      if (storedItemMatches(storedByCode.get(item.item_code), values)) continue;
      await upsertItemTx(tx, tid, cathCase.id, item.item_code, values);
    }

    const checkRows = await tx.$queryRawUnsafe(
      `SELECT id, status, completed_by, evidence_owner, source_name, attachment_ref, metadata
         FROM cath_lab_readiness_checks
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND check_type = 'labs'
        FOR UPDATE`,
      tid, cathCase.id,
    );
    const check = checkRows[0] || null;
    const decision = computeCheckDecision({
      items,
      settings,
      check: check || { status: 'pending', metadata: {} },
      caseRow: cathCase,
    });
    let checkStatus = check ? check.status : 'pending';
    let autoManaged = check?.metadata?.auto_managed === true;
    if (check) {
      const priorMetadata = check.metadata && typeof check.metadata === 'object'
        ? check.metadata
        : {};
      // The reason is RECOMPUTED, not carried forward: while automation owns a
      // pending check the stored line goes stale the moment a sample is drawn,
      // and the ward would keep reading "hb not ordered" about an item that is
      // now awaiting a result.
      const autoPendingReason = decision.nextStatus === 'pending'
        ? decision.autoPendingReason
        : decision.nextStatus === 'pass'
          ? null
          : (autoManaged && String(check.status || '').toLowerCase() === 'pending'
            ? pendingReasonFor(decision.missing)
            : priorMetadata.auto_pending_reason ?? null);
      // evidence_owner / source_name / attachment_ref describe WHO cleared the
      // check. Automation may claim them on a row it is moving, or on one it
      // already owns — never on a human's pass, whose named owner and attached
      // report are the record of a clinical decision and used to be overwritten
      // by the next case read.
      const ownsEvidence = Boolean(decision.nextStatus) || autoManaged;
      const attachmentRef = `lab_readiness:${cathCase.id}`;
      // The stored copy came back out of jsonb, so compare against the same
      // round trip: a Date on this side and its ISO string on that one are the
      // same evidence, and key order out of jsonb is not the order it went in.
      const evidenceJson = JSON.parse(JSON.stringify(items));
      const stampMs = toMs(priorMetadata.live_evidence_refreshed_at);
      const stampIsStale = !Number.isFinite(stampMs)
        || asOf.getTime() - stampMs > EVIDENCE_STAMP_MAX_AGE_MS;
      const changed = Boolean(decision.nextStatus)
        || (priorMetadata.critical_warning ?? null) !== decision.criticalWarning
        || !deepEqual(priorMetadata.critical_items ?? null, decision.criticalItems)
        || !deepEqual(priorMetadata.live_evidence ?? null, evidenceJson)
        || (priorMetadata.auto_pending_reason ?? null) !== autoPendingReason
        || (ownsEvidence && (check.evidence_owner !== 'lab_readiness'
          || check.source_name !== 'lab_results'
          || check.attachment_ref !== attachmentRef));
      if (changed || stampIsStale) {
        const metadataPatch = {
          critical_warning: decision.criticalWarning,
          critical_items: decision.criticalItems,
          live_evidence: items,
          live_evidence_refreshed_at: asOf.toISOString(),
          auto_pending_reason: autoPendingReason,
          ...(decision.nextStatus
            ? {
              auto_managed: true,
              auto_passed_at: decision.nextStatus === 'pass' ? asOf.toISOString() : null,
            }
            : {}),
        };
        await tx.$executeRawUnsafe(
          `UPDATE cath_lab_readiness_checks
              SET status = COALESCE($4::text, status),
                  completed_at = CASE
                    WHEN $4::text = 'pass' THEN NOW()
                    WHEN $4::text = 'pending' THEN NULL
                    ELSE completed_at
                  END,
                  completed_by = CASE WHEN $4::text IS NOT NULL THEN NULL ELSE completed_by END,
                  evidence_owner = CASE WHEN $6::boolean THEN 'lab_readiness' ELSE evidence_owner END,
                  source_name = CASE WHEN $6::boolean THEN 'lab_results' ELSE source_name END,
                  attachment_ref = CASE WHEN $6::boolean THEN $5 ELSE attachment_ref END,
                  metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::bigint`,
          tid,
          num(check.id),
          JSON.stringify(metadataPatch),
          decision.nextStatus,
          attachmentRef,
          ownsEvidence,
        );
      }
      if (decision.nextStatus) {
        checkStatus = decision.nextStatus;
        autoManaged = true;
        await recomputeCaseStatusTx(
          tx, tid, cathCase.id,
          context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null,
        );
        // The actor on an automation flip is the system, not whoever happened
        // to open the case: attributing it to a person would put a decision in
        // their audit trail that they never made.
        await recordReadinessAudit(tx, {
          tenantId: tid,
          action: `cath_lab.readiness.labs.auto_${decision.nextStatus}`,
          resource: 'cath_lab_readiness_checks',
          resourceId: num(check.id),
          context: { actorUid: null, actorRole: 'SYSTEM' },
          metadata: {
            case_id: cathCase.id,
            missing: decision.missing,
            critical_items: decision.criticalItems,
            reason: decision.autoPendingReason,
          },
        });
      }
    }
    return {
      case_id: cathCase.id,
      check_status: checkStatus,
      auto_managed: autoManaged,
      critical_warning: decision.criticalWarning,
      critical_items: decision.criticalItems,
      items,
      missing: decision.missing,
      orderable_now: orderCodesCovering(
        items
          .filter((item) => item.required && ['not_ordered', 'stale'].includes(item.state))
          .map((item) => item.item_code),
      ),
      // Only the orders the RESOLVER would honour. An order older than the
      // item's window is not evidence there either, so counting it here would
      // both leave the item not_ordered and refuse to re-order it — a case the
      // checklist could never make ready.
      open_order_codes: [...new Set(
        orders
          .filter((order) => !OPEN_ORDER_STATUSES_EXCLUDED.has(String(order.status || '').toUpperCase())
            && ITEM_CODES.some((code) => orderCoversItem(code, order)
              && withinWindow(instantMs(order, 'requested_at'), asOf, windowDaysFor(code))))
          .map((order) => String(order.test_code || '').toUpperCase()),
      )],
      settings: {
        lab_validity_days: settings.lab_validity_days,
        serology_validity_days: serologyDays,
        auto_pass: settings.auto_pass,
        external_results_count: settings.external_results_count,
        required_items: settings.required_items,
      },
      case_started: Boolean(cathCase.actual_start_at),
    };
  });
}

// Best-effort, post-commit: refresh every open case of a patient after a lab
// event. Failures are logged and never propagate into the lab write — a
// readiness snapshot that is one event behind is repaired by the next refresh;
// a lab result that failed to commit is not.
export async function refreshOpenCasesForPatient({ tenantId, patientUid } = {}) {
  try {
    const tid = tenantOr(tenantId);
    const uid = requireUuid(patientUid, 'patientUid');
    const cases = await setTenant(tid, (client) => client.$queryRawUnsafe(
      `SELECT id
         FROM cath_lab_cases
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND status IN ('scheduled', 'readiness_pending', 'ready')
          AND actual_start_at IS NULL`,
      tid, uid,
    ));
    for (const row of cases) {
      try {
        await refreshCaseLabReadiness({ tenantId: tid, caseId: num(row.id) });
      } catch (err) {
        logger.warn(`Cath lab readiness refresh failed for case ${row.id}: ${err?.message}`);
      }
    }
    return cases.length;
  } catch (err) {
    logger.warn(`Cath lab readiness refresh lookup failed: ${err?.message}`);
    return 0;
  }
}


// ---------------------------------------------------------------------------
// Facade
//
// Everything the three sibling modules export, re-exported here so an importer
// that only knows this file is unaffected by the split. Explicit name lists
// rather than `export *`: what this module publishes is a contract, and a name
// added to a sibling should reach it as a reviewed line rather than by
// accident.
// ---------------------------------------------------------------------------

export {
  AVAILABLE_STATES,
  DEFAULT_SEROLOGY_VALIDITY_DAYS,
  ITEM_CODES,
  ITEM_SOURCES,
  ITEM_STATES,
  OPEN_ORDER_STATUSES_EXCLUDED,
  SETTINGS_DEFAULTS,
  computeCheckDecision,
  externalNumericValue,
  instantMs,
  isCalendarDate,
  isCriticalResult,
  isItemAvailable,
  msToIso,
  orderCoversItem,
  pendingReasonFor,
  resolveItemState,
  toMs,
  withinWindow,
} from './cathLabReadinessRules.js';

export {
  orderMissingLabs,
  orderPriorityForUrgency,
  recordExternalLabResult,
  unwaiveLabItem,
  waiveLabItem,
} from './cathLabReadinessActions.js';

export {
  cleanText,
  num,
  positiveInt,
  requireUuid,
  tenantOr,
  withTenant,
} from './cathParamGuards.js';
