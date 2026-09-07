#!/usr/bin/env node
/**
 * Fail when a database timestamp is compared against the process clock through a
 * driver-materialised JS Date.
 *
 * WHY THIS EXISTS
 * The pg driver materialises a Postgres `timestamptz` as a JS Date in the
 * DATABASE SESSION timezone — for `$queryRaw*` and for the typed model delegates
 * alike. So `new Date(row.expires_at) < Date.now()` is correct only when that
 * session happens to be UTC. Several real defects shipped this way, two of them
 * FAIL-OPEN on a positive offset such as Asia/Kolkata (an expired HIU key and an
 * expired ABHA enrolment OTP were both accepted for up to 5h30m).
 *
 * Sessions are now pinned to UTC at the connection (`pinSessionTimeZoneToUrl` in
 * src/lib/prisma.js), which makes every such comparison correct today. This guard
 * is the second layer: it keeps the fragile shape from creeping back, so the
 * codebase does not silently depend on that pin.
 *
 * THE FIX this guard steers you towards: select an absolute-instant twin beside
 * the column and read it with `epochMsOrNull` from src/utils/dbInstant.js.
 *
 *     (EXTRACT(EPOCH FROM some_at) * 1000)::bigint AS some_at_epoch_ms
 *
 *     const expiry = epochMsOrNull(row.some_at_epoch_ms);
 *
 * THEN CHOOSE THE NULL BRANCH DELIBERATELY. No single idiom is right for every
 * column, and the docblock on src/utils/dbInstant.js is the arbiter. Two cases,
 * opposite answers:
 *
 *   1. AUTHORIZATION / EXPIRY GATE (consent, credential, approval, token) —
 *      absence must DENY, because you cannot establish the grant is still live:
 *
 *          if (expiry == null || expiry < Date.now()) { ... }   // treat as expired
 *
 *      as in the two ABDM consent gates in src/services/abdm/abdmService.js.
 *
 *   2. CAPABILITY / TTL FIELD, where NULL legitimately means "no expiry was
 *      configured" — absence is permissive:
 *
 *          if (expiry != null && expiry < Date.now()) { ... }
 *
 *      as in the key-material expiry in src/services/abdm/abdmHiuService.js.
 *
 * READING THE LEGACY LINE YOU ARE REPLACING (the practical tell): if it carried
 * an explicit truthiness guard, e.g.
 *
 *     if (row.expires_at && new Date(row.expires_at) < new Date())
 *
 * it was ALREADY permissive, and `!= null &&` preserves it faithfully. If it was
 * UNGUARDED it was fail-CLOSED, and only `== null ||` preserves it. That is the
 * exact line PR #881 crossed: every site it converted that had the guard stayed
 * faithful; the two UNGUARDED ABDM consent gates are the ones that flipped open.
 *
 * Never a bare `Number.isFinite`: `Number(null)` is 0 — finite, and reading as
 * 1970, i.e. "long ago". That fact cuts BOTH ways, which is exactly what makes
 * this easy to get wrong. It is why an unguarded legacy comparison such as
 * `new Date(row.expiry_date) < new Date()` was accidentally FAIL-CLOSED (a NULL
 * arrived as the epoch and compared as already expired, so the gate denied) —
 * and therefore why rewriting one to `expiry != null && ...` silently INVERTS it
 * into a fail-open. Preserving a gate's behaviour means `== null ||`, never
 * `!= null &&`. PR #881 made that slip on the nullable
 * `abdm_consents.expiry_date`, letting a consent with no expiry authorise a HIP
 * data export forever; PR #882 restored the deny branch.
 *
 * WHY IT IS CI-ONLY-DETECTABLE AS A *SHAPE*
 * CI runs a UTC database, so every one of these defects is behaviourally
 * invisible there — a relapse would ship green. Only the source shape can be
 * checked. That is also why this is a script rather than a jest assertion on
 * behaviour.
 *
 * KNOWN RECALL LIMITS (documented, not accidental)
 * The detector is tuned for zero false positives and therefore misses:
 *   - variable-mediated comparisons (`const t = row.x_at;` … `new Date(t) < …`),
 *   - bare model-delegate Dates (`session.expires_at < new Date()`, no wrapper),
 *   - `Date.parse(row.x_at)` and non-snake_case single-word timestamp columns.
 * It is a ratchet against the common shape, not a proof of absence. ARM 2's
 * registry below exists because that limit bites hardest on DATE columns: most
 * of the sites it names are variable-mediated and no regex can see them.
 *
 * ── ARM 2: DATE COLUMNS, AND WHY THEY NEED A DIFFERENT PRESCRIPTION ─────────
 *
 * A Postgres DATE is a CALENDAR DAY. It has no time and no zone — and it still
 * materialises through the driver as a JS Date, pinned to UTC midnight of that
 * day. `SELECT '2026-09-06'::date` hands back 2026-09-06T00:00:00.000Z, which is
 * not when that day begins on a +05:30 ward: that is 2026-09-05T18:30:00.000Z.
 * So a DATE compared against the clock is wrong by the facility's offset, in the
 * same 5h30m band as the two timestamptz defects above.
 *
 * DO NOT GIVE IT AN EPOCH TWIN. Arm 1's fix is exactly wrong here: an epoch twin
 * of a DATE re-freezes the same arbitrary midnight and makes the wrong instant
 * portable instead of removing it. A calendar day is only comparable to another
 * calendar day.
 *
 * THE FIX for a DATE is the calendar-date rail, src/utils/calendarDate.js — one
 * function per end, both resolving through the same facility zone:
 *
 *     const day   = calendarDateMs(row.expiry_date);   // the DATE, as a day
 *     const today = calendarDayStartMs(new Date());    // the WARD's today
 *     if (!Number.isFinite(day) || day < today) { ... }
 *
 * (`externalReportedMs` in services/clinical/cathLabReadinessRules.js is the
 * shape this came from — PR #1022 — and it now calls that rail.) Or keep the
 * question in SQL, which is equally correct:
 *
 *     WHERE expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
 *
 * The null branch is chosen the same deliberate way as arm 1's: `calendarDateMs`
 * returns NaN, never 0, and an authorisation gate must deny on it.
 *
 * WHAT THIS ARM IS THE THIRD INSTANCE OF. The readiness defect (PR #1022) was
 * the third member of a family this codebase had already NAMED, GUARDED, and
 * written an EXCEPTION into: `staff.hire_date` sat in ALLOWLIST below excused on
 * the grounds that "a DATE is not an instant, so it cannot be compared to the
 * clock" — which is the defect stated as a reason, and it put every DATE column
 * outside this guard's population by design. The lesson is not that a column was
 * missed; it is that a documented exception outlived the reasoning that
 * justified it and nothing re-examined it. That entry has been replaced, not
 * kept, by an arm-2 registry entry that says what is actually true of it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// TIMESTAMPTZ_GUARD_SRC exists so the guard's own test can run it against
// fixtures. Unset in CI, where it scans the real tree.
const backendRoot = process.env.TIMESTAMPTZ_GUARD_SRC
  ? path.resolve(process.env.TIMESTAMPTZ_GUARD_SRC)
  : path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(backendRoot, 'src');

// ── the detector ────────────────────────────────────────────────────────────
// An identifier chain (a, a.b, a?.b, a['b']) whose FINAL property looks like a
// database timestamp column: snake_case, or camelCase ending At/Date/Time/…
const OBJ = String.raw`[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.)[A-Za-z_$][A-Za-z0-9_$]*|\[\s*['"\`][^'"\`]*['"\`]\s*\]|\[\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\])*`;
const COL = String.raw`(?:(?:\?\.|\.)(?:[A-Za-z_$][A-Za-z0-9_$]*_[A-Za-z0-9_$]+|[A-Za-z_$][A-Za-z0-9$]*(?:At|Date|Time|Timestamp|Ts))|\[\s*['"\`][A-Za-z0-9_$]*_[A-Za-z0-9_$]+['"\`]\s*\])`;
const DBDATE = String.raw`new\s+Date\(\s*${OBJ}${COL}\s*\)(?:\.(?:getTime|valueOf)\(\))?`;
// The process clock. `new Date(new Date().toDateString())` — local midnight in
// whatever zone the PROCESS runs in — is listed FIRST because alternation is
// ordered and the bare `new Date()` inside it would otherwise match the prefix
// and leave the rest unconsumed. It earns its place: it is the shape three of
// the DATE-column gates in arm 2's registry were written in, and it is MORE
// wrong than a bare clock, not less, because it looks like a day comparison.
const CLOCK = String.raw`(?:new\s+Date\(\s*new\s+Date\(\s*\)\.toDateString\(\s*\)\s*\)(?:\.(?:getTime|valueOf)\(\))?|Date\.now\(\)|new\s+Date\(\s*\)(?:\.(?:getTime|valueOf)\(\))?)`;
const OP = String.raw`(?:<=|>=|<|>|-|===|!==|==|!=)`;
const DETECTOR = new RegExp(
  String.raw`${DBDATE}\s*${OP}\s*${CLOCK}|${CLOCK}\s*${OP}\s*${DBDATE}`,
  'g',
);

// ── reviewed exceptions ─────────────────────────────────────────────────────
// Matched on file + a substring of the offending expression, NOT on line number,
// so ordinary edits above them do not silently invalidate an entry.
const ALLOWLIST = [
  {
    file: 'src/services/auth/otpService.js',
    match: 'session.expires_at',
    reason:
      'Prisma model delegate (otp_sessions.findFirst with select:) — a computed '
      + 'epoch column cannot be attached to a delegate read. Correct via the UTC session pin.',
  },
  {
    file: 'src/services/otpService.js',
    match: 'last.created_at',
    reason:
      'Prisma model delegate (findFirst with select: { created_at: true }) — same '
      + 'constraint as above. Correct via the UTC session pin.',
  },
  {
    file: 'src/services/emr/cdsEngine.js',
    match: 'admission.admitted_at',
    reason:
      'Prisma model delegate read — cannot carry a computed column. Correct via the '
      + 'UTC session pin. Used for a daysAdmitted display metric, not an authorisation gate.',
  },
  // The staff.hire_date entry that used to sit here has been REPLACED, not
  // moved: see DATE_CLOCK_SITES below. Its reasoning — "a DATE column, not
  // timestamptz, so it carries no session-timezone offset" — was true in every
  // clause and false in its conclusion, and it is what put the whole DATE class
  // outside this guard by design.
];

// ── ARM 2: the DATE population ──────────────────────────────────────────────
// Every DISTINCT `date`-typed column name in the schema, from
// information_schema.columns (data_type = 'date'). Two are deliberately left
// out — `d` and `day`, the BI rollup keys — because the COL pattern above
// cannot match a name with no underscore and no At/Date/Time suffix, so listing
// them would only inflate the denominator.
// This is the CLASSIFIER, not the subject: a hit whose column is named here is
// reported with the calendar-date prescription instead of the epoch twin.
//
// Read the `_at` names in it. `renewal_due_at`, `tested_at`, `installed_at`,
// `enrolled_at`, `registered_at`, `last_certified_at`, `undertaking_signed_at`
// are all DATE columns wearing the suffix this codebase uses for instants — so
// the name alone would send every one of them down arm 1's rail and give it an
// epoch twin, which is the wrong fix. The type is the arbiter, never the name.
const DATE_COLUMNS = new Set([
  'abandoned_date', 'actual_end_date', 'amc_expires_on', 'amc_starts_on',
  'anniversary', 'appointment_date', 'audit_date', 'birthday',
  'booking_visit_date', 'bundle_date', 'collected_date', 'collection_date',
  'contract_end_date', 'created_date', 'date', 'date_of_birth',
  'date_of_death', 'date_of_diagnosis', 'date_of_joining', 'date_of_onset', 'dob',
  'deferral_until', 'deferred_until', 'diagnosis_date', 'dispute_date',
  'due_date', 'due_on', 'edd_date', 'effective_date', 'effective_end_date',
  'effective_from', 'effective_on', 'effective_start_date', 'effective_to',
  'end_date', 'ends_on', 'enrolled_at', 'exception_date',
  'expected_admission_date', 'expires_earliest', 'expiry_date',
  'export_period_end', 'export_period_start', 'external_reported_on',
  'first_used_date', 'follow_up_date', 'forecast_date', 'hire_date',
  'incident_date', 'installed_at', 'invoice_date', 'join_date',
  'last_certified_at', 'last_doppler_date', 'last_qa_check_date',
  'last_review_date', 'last_working_day', 'lmp_date', 'log_date',
  'manufacture_date', 'mfr_date', 'month', 'month_start', 'next_expiry_date',
  'next_visit_date', 'onset_date', 'payment_date', 'pcpndt_training_date',
  'period_end', 'period_start', 'preferred_date', 'pregnancy_lmp_date',
  'purchase_date', 'qa_date', 'queue_date', 'record_date',
  'reference_period_end', 'reference_period_start', 'registered_at',
  'registration_valid_to', 'renewal_due_at', 'reporting_due_date',
  'requested_end_date', 'requested_start_date', 'resolved_date',
  'retention_until', 'review_date', 'review_due_on', 'roster_date',
  'scheduled_date', 'scheduled_for', 'service_date', 'session_date',
  'signal_date', 'source_day', 'start_date', 'starts_on', 'study_date',
  'target_due_date', 'target_end_date', 'test_date', 'tested_at',
  'tested_on', 'undertaking_signed_at', 'valid_from', 'valid_to',
  'valid_until', 'visit_date', 'warranty_expires_on', 'warranty_until',
  'window_end', 'window_start',
]);

// ── ARM 2: the REACHING SET, which is this arm's actual subject ─────────────
// The DATE columns that reach a clock comparison, one entry per SITE, with what
// the comparison DECIDES — because that, not how often a column appears, is what
// says which ones had to be fixed first.
//
// It is a hand-reviewed registry rather than a scan result on purpose: most of
// these are invisible to any regex (`const due = new Date(row.due_date)` and
// then `due < today` twenty lines later), which is the documented recall limit
// above. So the enumeration is the artefact, and the guard's job is to keep it
// HONEST — see the staleness check below:
//
//   status: 'fixed'      — on the calendar-date rail now. The old expression
//                          must be GONE and the file must import the rail. A
//                          revert therefore fails this guard.
//   status: 'next_slice' — still on the wrong rail, reviewed and deferred with
//                          a stated reason. The expression must still be there;
//                          when it goes, the entry is stale and must be deleted.
//
// SNAPSHOT the COLUMNS, not the sites, and count the ones that REACH a clock —
// not the 109 that exist. A snapshot of the existing set would sit green while
// the reaching set grew, which is exactly the failure this arm was added for.
const DATE_CLOCK_SITES = Object.freeze([
  // -- authorisation / expiry gates: fixed in this change --------------------
  {
    file: 'src/services/bloodbank/transfusionSafetyService.js',
    column: 'expiry_date',
    decides: 'authorisation gate — whether an expired blood unit may be issued',
    was: 'new Date(unit.expiry_date) < new Date(new Date().toDateString())',
    status: 'fixed',
  },
  {
    file: 'src/services/bloodbank/transfusionSafetyService.js',
    column: 'expiry_date',
    decides: 'authorisation gate — the bedside scan\'s expiryOk hard stop',
    was: 'new Date(unit.expiry_date) >= new Date(new Date().toDateString())',
    status: 'fixed',
  },
  {
    file: 'src/services/staff/credentialingService.js',
    column: 'valid_until',
    decides: 'authorisation gate — hasActivePrivilege, behind assertPrivilegeForGate',
    was: 'new Date(rows[0].valid_until) < new Date(new Date().toDateString())',
    status: 'fixed',
  },
  {
    file: 'src/services/staff/credentialingService.js',
    column: 'renewal_due_at',
    decides: 'expiry alerting — days_remaining and the severity band on a credential',
    was: 'const today = new Date(new Date().toDateString());',
    status: 'fixed',
  },
  {
    file: 'src/services/ai/aiAgentLifecycleService.js',
    column: 'expiry_date',
    decides: 'authorisation gate — the EXPIRED / EXPIRY_IMMINENT band that quarantines an agent',
    was: 'const expiryDate = registryRow?.expiry_date ? new Date(registryRow.expiry_date) : null;',
    status: 'fixed',
  },
  {
    file: 'src/controllers/investigation/bulkController.js',
    column: 'scheduled_date',
    decides: 'validation gate — refuses a bulk schedule dated in the past',
    was: 'today.setHours(0, 0, 0, 0);',
    status: 'fixed',
  },

  // -- money / eligibility: NEXT SLICE ---------------------------------------
  {
    file: 'src/services/staff/payrollService.js',
    column: 'effective_from',
    decides: 'money — whether salary arrears are required (two comparisons in one command)',
    match: 'if (effectiveDate >= new Date(r.applied_at || now))',
    deferred:
      'day-vs-day is the right rail and it CHANGES this answer: a revision applied ON its '
      + 'effective date currently pays arrears and would stop. That is a payroll decision, not '
      + 'a clock one, and it needs its own owner sign-off.',
    status: 'next_slice',
  },
  {
    file: 'src/controllers/staff/payrollController.js',
    column: 'date_of_joining',
    decides: 'money — gratuity eligibility at five years of service',
    match: 'const yos = (now - joinDate)',
    deferred:
      'the five-year anniversary of a 29 February join date has no calendar day, so the rail '
      + 'needs a documented rule for it before this moves.',
    status: 'next_slice',
  },
  {
    file: 'src/controllers/staff/payrollController.js',
    column: 'date_of_joining',
    decides: 'display — days_to_five_years on the gratuity dashboard',
    match: 'Math.ceil((fiveYearDate-now)',
    deferred: 'same anniversary rule as the eligibility line above; they move together.',
    status: 'next_slice',
  },

  // -- scheduling / clinical evidence: NEXT SLICE ----------------------------
  {
    file: 'src/utils/investigation/investigationHelpers.js',
    column: 'scheduled_date',
    decides: 'scheduling — whether an investigation booking reads as overdue',
    match: 'return new Date(scheduledDate) < new Date();',
    deferred: 'shared helper with several callers; needs each caller\'s day semantics confirmed.',
    status: 'next_slice',
  },
  {
    file: 'src/services/paediatric/paediatricImmunisationService.js',
    column: 'due_date',
    decides: 'clinical evidence — overdue vs due-window on a childhood immunisation',
    match: 'if (due.getTime() < today.getTime() && !row.given_at)',
    deferred: 'the +/- window arithmetic beside it is in milliseconds and moves to days with it.',
    status: 'next_slice',
  },
  {
    file: 'src/services/staff/hr/dashboardService.js',
    column: 'hire_date',
    decides: 'display — upcoming work anniversaries in the next 30 days',
    match: 'if (dueDate < now || dueDate > horizon)',
    deferred:
      'display only — a work-anniversary strip. The five hire_date sites move as one'
      + 'slice, so the column is retired in a single reviewable diff.',
    status: 'next_slice',
  },
  {
    file: 'src/services/clinical/growthPercentileService.js',
    column: 'birthday',
    decides: 'clinical evidence — age in days, which selects the WHO growth reference row',
    match: 'export function ageInDaysFrom(birthday, asOf = new Date())',
    deferred:
      'a paediatric age band is a clinical input: moving the day boundary shifts percentile '
      + 'selection for neonates and wants a clinician to confirm the ward-day rule first.',
    status: 'next_slice',
  },
  {
    file: 'src/services/clinical/nicuPicuChartingService.js',
    column: 'birthday',
    decides: 'clinical evidence — the same age band, on the NICU/PICU chart',
    match: 'ageInDaysFrom(patient.birthday, weightRow.recorded_at || new Date())',
    deferred: 'moves with growthPercentileService.ageInDaysFrom above.',
    status: 'next_slice',
  },
  {
    file: 'src/services/research/researchRegistryService.js',
    column: 'birthday',
    decides: 'eligibility — the age_years criterion binding for a research cohort',
    match: 'new Date(rows[0].birthday).getTime()',
    deferred: 'cohort membership is reproducible evidence; changing it needs a registry decision.',
    status: 'next_slice',
  },

  // -- display / analytics: NEXT SLICE ---------------------------------------
  {
    file: 'src/services/pharmacy/inventoryService.js',
    column: 'expiry_date',
    decides: 'display — the expired-stock report',
    match: 'expiry_date: { lt: new Date() }',
    deferred: 'a Prisma delegate filter; the rail here is a SQL DATE comparison, not a JS one.',
    status: 'next_slice',
  },
  {
    file: 'src/services/ai/biomedDeviceMaintenanceService.js',
    column: 'warranty_expires_on',
    decides: 'display — days to warranty expiry on a biomedical device',
    match: 'const diffDays = Math.floor((expiresMs - now)',
    deferred:
      'display only — a days-to-warranty number on a device card that no gate reads.',
    status: 'next_slice',
  },
  {
    file: 'src/services/ai/inventoryIntelligenceService.js',
    column: 'next_expiry_date',
    decides: 'display — days to the next batch expiry in an inventory alert',
    match: 'const todayDate = today ? toDateOnly(today) : new Date();',
    deferred:
      'display only. toDateOnly here is a second, LOCAL copy of the calendar-date rail;'
      + 'the fix deletes it in favour of the shared one, with the copy below.',
    status: 'next_slice',
  },
  {
    file: 'src/services/ai/procurementNegotiationService.js',
    column: 'contract_end_date',
    decides: 'display — days to contract end in a procurement opportunity',
    match: 'const todayDate = today ? toDateOnly(today) : new Date();',
    deferred:
      'display only, and the same duplicated toDateOnly as inventoryIntelligenceService'
      + '— the two fold into the shared rail together or neither does.',
    status: 'next_slice',
  },
  {
    // THIS IS THE ENTRY THAT REPLACES THE OLD ALLOWLIST EXCEPTION.
    //
    // It used to read, in ALLOWLIST: "staff.hire_date is a DATE column, not
    // timestamptz (verified against information_schema), so it carries no
    // session-timezone offset." Every clause of that is true and the conclusion
    // is false. A DATE carries no offset, and that is exactly the problem: the
    // driver supplies one anyway, materialising it at UTC midnight, which is
    // 05:30 on a +05:30 ward. Excusing it here is what put the whole DATE class
    // outside this guard by design, and PR #1022 was the third defect to walk
    // through the gap.
    file: 'src/services/staff/hr/onboardingService.js',
    column: 'hire_date',
    decides: 'display — days since hire on the onboarding progress card',
    match: 'new Date(staff.hire_date)',
    deferred:
      'display only — days since hire on a progress card. Batched with the other four'
      + 'hire_date sites so the column is retired in one reviewable diff.',
    status: 'next_slice',
  },
  {
    file: 'src/services/staff/hr/departmentService.js',
    column: 'hire_date',
    decides: 'display — average tenure in a department roll-up',
    match: 'const years = (now - s.hire_date) / YEAR_MS;',
    deferred:
      'a BARE delegate Date with no new Date() wrapper, so arm 1\'s detector cannot see it '
      + 'either; display only.',
    status: 'next_slice',
  },
  {
    file: 'src/services/staff/hr/departmentService.js',
    column: 'hire_date',
    decides: 'display — per-staff tenure in the same roll-up',
    match: 'tenure: s.hire_date ? Math.floor((now - s.hire_date) / YEAR_MS) : 0,',
    deferred:
      'the same bare-delegate shape as the line above, in the same function, and one'
      + 'edit with it. Display only.',
    status: 'next_slice',
  },
  {
    file: 'src/controllers/pharmacy/pharmacyOrderController.js',
    column: 'birthday',
    decides: 'display — the age printed on a dispense label',
    match: 'const diffMs = Date.now() - dob.getTime();',
    deferred:
      'display only — a printed age. The four printed-age sites read the same column'
      + 'the same way and move together; none may be left behind.',
    status: 'next_slice',
  },
  {
    file: 'src/controllers/prescription/ePrescriptionController.js',
    column: 'birthday',
    decides: 'display — Age/Gender on a printed prescription',
    match: 'new Date(patient.birthday).getTime()',
    deferred:
      'display only — the Age/Gender line on a printed prescription, duplicated in the'
      + 'PDF helper below; the two must not drift apart.',
    status: 'next_slice',
  },
  {
    file: 'src/services/prescription/prescriptionPdfHelper.js',
    column: 'birthday',
    decides: 'display — Age/Gender on the prescription PDF',
    match: 'new Date(patient.birthday).getTime()',
    deferred:
      'display only — the same Age/Gender arithmetic as the controller above, copied'
      + 'here for the PDF; both go down the rail in one change.',
    status: 'next_slice',
  },
  {
    file: 'src/controllers/chatbot/chatbotController.js',
    column: 'birthday',
    decides: 'display — the age the assistant quotes back',
    match: 'new Date(r.birthday).getTime()',
    deferred:
      'display only — an age quoted back in conversation. Last of the printed-age'
      + 'family, and it moves with them.',
    status: 'next_slice',
  },
  {
    file: 'src/services/bloodbank/donorIntakeService.js',
    column: 'date_of_birth',
    decides: 'eligibility — donor age at intake, read in UTC rather than the ward day',
    match: 'today.getUTCFullYear() - dob.getUTCFullYear()',
    deferred:
      'donor age bands are a regulatory input; the day boundary moves by five and a half '
      + 'hours and wants blood-bank sign-off rather than a drive-by fix.',
    status: 'next_slice',
  },
]);

const DATE_NEXT_SLICE = DATE_CLOCK_SITES.filter((site) => site.status === 'next_slice');
const DATE_FIXED_SITES = DATE_CLOCK_SITES.filter((site) => site.status === 'fixed');

/**
 * The DATE columns that REACH a clock comparison — the arm's population, and
 * the number the snapshot test pins. Derived from the registry above rather
 * than transcribed, so removing a site removes its column from the count.
 */
const DATE_CLOCK_REACHING_COLUMNS = Object.freeze(
  [...new Set(DATE_CLOCK_SITES.map((site) => site.column))].sort(),
);

/**
 * The calendar-date rail every 'fixed' entry must still be importing.
 *
 * Matched on the RAW source, not the blanked copy: blankNonCode erases string
 * bodies, and a module specifier is a string. A comment quoting the path would
 * not satisfy it either — the shape below is an import statement.
 */
const CALENDAR_RAIL = 'utils/calendarDate.js';
const CALENDAR_RAIL_IMPORT = /(?:^|[\s;{])from\s*['"][^'"]*utils\/calendarDate\.js['"]/;

/**
 * The column an offending expression is about: the last snake_case or
 * date-suffixed property in it. Used only to CLASSIFY a hit into an arm, so a
 * miss costs the wrong advice, never a missed violation.
 */
const COLUMN_IN_TEXT = /(?:\.|\[\s*['"`])([A-Za-z_$][A-Za-z0-9_$]*)/g;
function columnOf(text) {
  const names = [...text.matchAll(COLUMN_IN_TEXT)].map((m) => m[1]);
  return names.reverse().find((name) => DATE_COLUMNS.has(name)) ?? null;
}

function isDateColumnHit(text) {
  return columnOf(text) !== null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'tests' || name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(?:js|mjs|cjs)$/.test(name) && !/\.(?:test|spec)\.[cm]?js$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// Blank comments and string/template bodies so prose and SQL text cannot match,
// preserving byte offsets (and therefore line numbers) exactly.
function blankNonCode(source) {
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      onComment: comments,
    });
  } catch (err) {
    // A parse failure must be an error, never a silent skip — otherwise the
    // guard degrades to zero coverage without anyone noticing.
    const e = new Error(`parse failed: ${err.message}`);
    e.parseFailure = true;
    throw e;
  }

  const chars = [...source];
  const blank = (start, end) => {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  for (const c of comments) blank(c.start, c.end);

  // Blank string bodies, but keep bare-identifier strings so row['expires_at']
  // stays matchable.
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.value)) blank(node.start + 1, node.end - 1);
    } else if (node.type === 'TemplateElement') {
      blank(node.start, node.end);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast);
  return chars.join('');
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

function isAllowed(rel, text) {
  return ALLOWLIST.find((a) => a.file === rel && text.includes(a.match));
}

/**
 * Find every clock comparison in one source string. Exported so the guard's own
 * test can pin both what it catches and what it deliberately ignores, without
 * needing fixture files on disk.
 */
export function scanSource(source) {
  const code = blankNonCode(source);
  const hits = [];
  DETECTOR.lastIndex = 0;
  let m;
  while ((m = DETECTOR.exec(code)) !== null) {
    hits.push({
      line: lineOf(source, m.index),
      text: source.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(),
    });
  }
  return hits;
}

export {
  DETECTOR,
  ALLOWLIST,
  DATE_COLUMNS,
  DATE_CLOCK_SITES,
  DATE_NEXT_SLICE,
  DATE_FIXED_SITES,
  DATE_CLOCK_REACHING_COLUMNS,
  columnOf,
  isDateColumnHit,
};

// Executed as a script: scan the tree and report. Importing this module (the
// guard's own test does) runs nothing, so the helpers above stay testable.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const files = walk(SRC);
  const violations = [];
  const dateViolations = [];
  const parseFailures = [];
  const allowedHits = new Set();
  const dateToleratedHits = new Set();
  // rel -> blanked source, for the registry staleness pass below. Kept from the
  // same read the detector used, so the two can never disagree about a file.
  const blankedByRel = new Map();
  const rawByRel = new Map();

  for (const abs of files) {
    const rel = path.relative(backendRoot, abs).split(path.sep).join('/');
    const source = readFileSync(abs, 'utf8');
    let hits;
    try {
      hits = scanSource(source);
      blankedByRel.set(rel, blankNonCode(source));
      rawByRel.set(rel, source);
    } catch (err) {
      parseFailures.push({ rel, message: err.message });
      continue;
    }
    for (const hit of hits) {
      // ARM 2 FIRST. A DATE column that also matches arm 1's detector must get
      // the calendar-date prescription, not the epoch twin — the epoch twin
      // would freeze the same wrong midnight and look like a fix.
      const column = columnOf(hit.text);
      if (column !== null) {
        const site = DATE_NEXT_SLICE.find(
          (s) => s.file === rel && hit.text.includes(s.match),
        );
        if (site) { dateToleratedHits.add(`${rel}::${site.match}`); continue; }
        dateViolations.push({ rel, line: hit.line, text: hit.text, column });
        continue;
      }
      const entry = isAllowed(rel, hit.text);
      if (entry) { allowedHits.add(`${rel}::${entry.match}`); continue; }
      violations.push({ rel, line: hit.line, text: hit.text });
    }
  }

  // A stale allowlist entry is itself a defect: it means the site was fixed (good)
  // or moved (bad) and the exception is now silently covering nothing.
  const staleAllowlist = ALLOWLIST.filter((a) => !allowedHits.has(`${a.file}::${a.match}`));

  // ARM 2's registry is kept honest by SOURCE presence, not by detector hits:
  // most of these sites are variable-mediated and no regex sees them, which is
  // the whole reason the enumeration is written down.
  const staleDateSites = [];
  const revertedDateFixes = [];
  for (const site of DATE_CLOCK_SITES) {
    const code = blankedByRel.get(site.file);
    if (code === undefined) {
      staleDateSites.push({ ...site, why: 'the file no longer exists (or no longer parses)' });
      continue;
    }
    if (site.status === 'next_slice') {
      if (!code.includes(site.match)) {
        staleDateSites.push({
          ...site,
          why: 'the expression is gone — fixed, or moved. Delete the entry, or repoint it.',
        });
      }
      continue;
    }
    // status: 'fixed'. Both halves are asserted, so neither a silent revert nor
    // a fix that merely deleted the line can pass.
    if (site.was && code.includes(site.was)) {
      revertedDateFixes.push({ ...site, why: 'the pre-fix expression is BACK in the file' });
    }
    if (!CALENDAR_RAIL_IMPORT.test(rawByRel.get(site.file) ?? '')) {
      revertedDateFixes.push({ ...site, why: `the file no longer imports ${CALENDAR_RAIL}` });
    }
  }

  // POPULATION DISCIPLINE. A guard that has quietly stopped looking at anything
  // reports success just as loudly as one that looked and found nothing, which
  // is how a whole column class sat outside this file for three defects. Each
  // arm therefore has to be able to say what it was looking AT.
  const populationProblems = [];
  if (!files.length) populationProblems.push('no source files were scanned at all');
  if (!ALLOWLIST.length) {
    populationProblems.push('arm 1 (timestamptz) has no reviewed population left');
  }
  if (!DATE_COLUMNS.size) {
    populationProblems.push('arm 2 (DATE) has an empty column vocabulary');
  }
  if (!DATE_CLOCK_SITES.length) {
    populationProblems.push('arm 2 (DATE) has an empty reaching set');
  }
  if (!DATE_CLOCK_REACHING_COLUMNS.length) {
    populationProblems.push('arm 2 (DATE) names no column that reaches a clock');
  }

  if (parseFailures.length) {
    console.error('timestamptz clock-comparison guard: could not parse:');
    for (const f of parseFailures) console.error(`  ${f.rel}: ${f.message}`);
    process.exit(1);
  }

  if (violations.length) {
    console.error(
      `clock-comparison guard, ARM 1 (timestamptz): ${violations.length} site(s) compare a `
      + 'driver-materialised database timestamp against the process clock.\n',
    );
    for (const v of violations) console.error(`  ${v.rel}:${v.line}\n      ${v.text}`);
    console.error(
      '\nA timestamptz read back through the pg driver is shifted by the DATABASE'
      + '\nSESSION timezone, so this comparison is only correct on a UTC session.'
      + '\nSelect an absolute-instant twin and read it with epochMsOrNull:'
      + '\n    (EXTRACT(EPOCH FROM <col>) * 1000)::bigint AS <col>_epoch_ms'
      + '\n    const t = epochMsOrNull(row.<col>_epoch_ms);'
      + '\n'
      + '\nThen pick the NULL branch on purpose. src/utils/dbInstant.js is the'
      + '\narbiter; there is no one right idiom:'
      + '\n  * AUTHORIZATION / EXPIRY GATE (consent, credential, approval, token)'
      + '\n    -- absence must DENY:'
      + '\n        if (t == null || t < Date.now()) { /* treat as expired */ }'
      + '\n  * CAPABILITY / TTL field, where NULL means "no expiry configured"'
      + '\n    -- absence is permissive:'
      + '\n        if (t != null && t < Date.now()) { ... }'
      + '\n'
      + '\nTell, when converting a legacy line: if it had a truthiness guard, as in'
      + '\n"if (row.col && new Date(row.col) < ...)", it was already permissive, so'
      + '\n"!= null &&" is faithful. If it was UNGUARDED it was fail-CLOSED, and only'
      + '\n"== null ||" preserves that.'
      + '\n'
      + '\nNever a bare isFinite: Number(null) is 0, which reads as 1970. That cuts'
      + '\nBOTH ways -- it is why the unguarded legacy comparison you are replacing'
      + '\nwas accidentally FAIL-CLOSED, and so why a naive rewrite to "!= null &&"'
      + '\nsilently flips a gate OPEN. That was PR #881 on the nullable'
      + '\nabdm_consents.expiry_date; PR #882 restored the deny branch.'
      + '\n'
      + '\nIf the row comes from a Prisma model delegate a twin is impossible -- add a'
      + '\nreviewed entry to ALLOWLIST in this script explaining why.'
      + '\n'
      + '\nIf the column is a DATE, this is the WRONG advice: see ARM 2 below.\n',
    );
    process.exit(1);
  }

  if (dateViolations.length) {
    console.error(
      `clock-comparison guard, ARM 2 (DATE): ${dateViolations.length} site(s) compare a `
      + 'CALENDAR DATE against the process clock.\n',
    );
    for (const v of dateViolations) {
      console.error(`  ${v.rel}:${v.line}   (${v.column} is a DATE)\n      ${v.text}`);
    }
    console.error(
      '\nA Postgres DATE is a calendar DAY. It has no time and no zone, and the'
      + '\ndriver materialises it at UTC MIDNIGHT anyway -- which is 05:30 on a'
      + '\n+05:30 ward, not the start of that day. Compared against the clock it is'
      + '\nwrong by the facility offset for five and a half hours out of every'
      + '\ntwenty-four.'
      + '\n'
      + '\nDO NOT GIVE IT AN EPOCH TWIN. Arm 1\'s fix is exactly wrong here: an epoch'
      + '\ntwin of a DATE re-freezes the same arbitrary midnight and makes the wrong'
      + '\ninstant portable instead of removing it. A day is only comparable to a day.'
      + '\n'
      + '\nUse the calendar-date rail, src/utils/calendarDate.js -- one function per'
      + '\nend, both resolving through the same facility zone:'
      + '\n    const day   = calendarDateMs(row.<col>);      // the DATE, as a day'
      + '\n    const today = calendarDayStartMs(new Date()); // the WARD\'s today'
      + '\n    if (!Number.isFinite(day) || day < today) { /* expired */ }'
      + '\n'
      + '\n...or keep the question in SQL, which is equally correct:'
      + '\n    WHERE <col> < (NOW() AT TIME ZONE \'Asia/Kolkata\')::date'
      + '\n'
      + '\nThe NULL branch is still yours to choose, and calendarDateMs returns NaN'
      + '\nrather than 0 so that a bare isFinite slip cannot turn a missing date into'
      + '\nan expired one: an AUTHORISATION gate denies on NaN, a capability field may'
      + '\npermit it.'
      + '\n'
      + '\nIf this site is a reviewed deferral, add it to DATE_CLOCK_SITES in this'
      + '\nscript with status "next_slice", the column, what the comparison DECIDES,'
      + '\nand why it is deferred. Silence is not an option this guard offers.\n',
    );
    process.exit(1);
  }

  if (staleAllowlist.length) {
    console.error('clock-comparison guard: stale ALLOWLIST entries (no longer match anything):');
    for (const a of staleAllowlist) console.error(`  ${a.file} :: ${a.match}`);
    console.error('\nRemove them, or fix the path if the code moved.\n');
    process.exit(1);
  }

  if (staleDateSites.length) {
    console.error('clock-comparison guard, ARM 2: stale DATE_CLOCK_SITES entries:');
    for (const site of staleDateSites) {
      console.error(`  ${site.file} :: ${site.match ?? site.was}\n      ${site.why}`);
    }
    console.error(
      '\nThe registry is the enumeration of what still reaches a clock. An entry'
      + '\nthat matches nothing is a claim about the tree that is no longer true.\n',
    );
    process.exit(1);
  }

  if (revertedDateFixes.length) {
    console.error('clock-comparison guard, ARM 2: a fixed DATE site has regressed:');
    for (const site of revertedDateFixes) {
      console.error(`  ${site.file} :: ${site.column}\n      ${site.why}`);
    }
    console.error(
      `\nEach 'fixed' entry asserts BOTH that the pre-fix expression is gone AND`
      + `\nthat the file still imports ${CALENDAR_RAIL}, so a revert cannot pass as`
      + '\na deletion.\n',
    );
    process.exit(1);
  }

  if (populationProblems.length) {
    console.error('clock-comparison guard: an arm is looking at nothing:');
    for (const problem of populationProblems) console.error(`  ${problem}`);
    console.error(
      '\nA guard with an empty population passes as loudly as one that found'
      + '\nnothing. That is how the DATE class sat outside this file for three'
      + '\ndefects, so each arm has to be able to say what it looked at.\n',
    );
    process.exit(1);
  }

  console.log(
    `clock-comparison guard passed (${files.length} files scanned).\n`
    + `  arm 1 (timestamptz -> epoch twin): ${ALLOWLIST.length} reviewed exceptions.\n`
    + `  arm 2 (DATE -> calendar-date rail): ${DATE_CLOCK_REACHING_COLUMNS.length} of `
    + `${DATE_COLUMNS.size} DATE columns reach a clock comparison, over `
    + `${DATE_CLOCK_SITES.length} sites — ${DATE_FIXED_SITES.length} on the rail, `
    + `${DATE_NEXT_SLICE.length} reviewed and deferred (${dateToleratedHits.size} of them `
    + 'also visible to the detector).',
  );

}
