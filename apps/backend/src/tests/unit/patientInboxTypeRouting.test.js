// Routing gate: every `notifications.type` this backend writes for a PATIENT
// must be a type the patient app's inbox actually routes.
//
// A row that renders but goes nowhere is the same defect as no row. The push
// behind it is privacy-stripped to a generic "You have a new update" landing
// on /notifications (sendPushNotification.js:36-43, :116-135), so the inbox
// row is the whole message — and the only thing that turns it back into a
// destination is the generated patient notification contract consumed by
// `_handleNotificationTap` in notifications_screen.dart. An unknown type is
// deliberately non-actionable.
//
// `ePrescriptionController` wrote type 'prescription' and was reviewed as
// already-compliant on the strength of writing a row at all: it had no route,
// so the row was inert. This gate is the durable form of that review — the
// routed set comes from the same backend registry that generates the Dart
// action table, so the two stacks cannot silently drift.
//
// ── THE COMPLETENESS CONTRACT ─────────────────────────────────────────────
//
// FOUR mechanisms put a type on a `notifications` row, and all four are
// scanned. The file/site set of each is checked against a source scan in BOTH
// directions, so a new writer fails here until someone dispositions it:
//
//   1. `recordPatientFeedNotification({ type: '…' })` — fully mechanical:
//      every call site anywhere under src/ is found and its type expression
//      resolved.
//   2. a direct `INSERT INTO notifications` — in any spelling Postgres accepts
//      for that table (bare, `public.notifications`, `"notifications"`) —
//      enumerated below with a disposition. For the `patient` ones the type is
//      not merely grepped for: the column list and the VALUES list are split
//      positionally, the slot opposite the `type` column is resolved, and a
//      `$N` slot is followed to the Nth bind argument of the raw-SQL call. See
//      TYPE-SLOT RESOLUTION.
//   3. `dispatch(...)` / `dispatchToPatient(...)` — the dispatcher's inapp
//      branch writes the row itself. Call sites scanned; dispositions below.
//   4. a Prisma WRITE on the `notifications` model — `create`, `createMany`,
//      `createManyAndReturn`, `upsert`, and the `update` family. The scanner
//      matches the model and classifies the method rather than pinning method
//      names into a regex; the type is an ordinary object property here, so it
//      is read straight out of the call's argument text. This mechanism was
//      invisible to both gates until 2026-08-24 and was writing two live
//      patient rows ('investigation_ordered', 'investigation_ready') that the
//      tap handler did not route. The same day, the version that replaced it
//      still saw only `create`/`createMany`.
//
// Plus the indirect path: an outbox row whose resolved channels contain
// `inapp` re-enters dispatch() with the OUTBOX row's type, so every
// tenant-configurable type is checked through `feedRowTypeForTransportType`
// too.
//
// Nothing else can set the column: `notifications.type` is written only at
// INSERT — asserted below — so resolving the INSERT settles the row's type.
//
// ── TYPE-SLOT RESOLUTION, AND WHAT IT DOES NOT PROVE ──────────────────────
//
// The earlier version of mechanism 2 declared labResultsService's two types as
// literals and asserted only that those strings appeared SOMEWHERE in the
// file. That is not a proof about the row: `notifyPatientResultRecipients`
// takes `type` as a PARAMETER, so a caller passing a third, unrouted literal
// would have satisfied the gate untouched. Both halves are now real:
//
//   * a `patient` writer whose type slot resolves to a LITERAL must declare
//     exactly that literal set in `types`, and each must be routed;
//   * a `patient` writer whose type slot resolves to an IDENTIFIER must
//     declare `typeFrom` — the exported function that identifier is a
//     parameter of. The gate then checks the INSERT really sits inside that
//     function, that the function destructures that parameter, and scans EVERY
//     call site of it under src/, in every file: each must pass a decidable
//     `type:`, each value it can take must be routed, and their union must
//     equal the declared `types`.
//
// "Decidable" is the load-bearing word, and it is enforced rather than hoped
// for. `typeLiteralsFrom` resolves a quoted literal to itself and a
// conditional to the union of its branches, and returns anything else — a
// variable, a template literal, a lookup, a concatenation — as UNRESOLVED,
// which fails. The predecessor of this gate used a `type: '…'` regex, which
// returned nothing at all for `type: corrected ? 'a' : 'b'` and so could not
// distinguish a computed type from a call carrying no type.
//
// What it still does not prove, stated so nobody reads more into it. (a) A
// hand-written `INSERT … SELECT` that computes the type in SQL resolves as
// unparsed and FAILS rather than passing — the intended direction — but it
// means such a writer cannot be dispositioned `patient` without extending this
// parser. (b) Non-`patient` dispositions (`staff`, `operator`, `infra`) are
// NOT type-resolved at all; they are accounted for by file/site set equality
// only, because the patient inbox is not the surface that reads them, and a
// row's audience is a judgement about its recipient that no regex settles.
// (c) The audience judgement itself is the table's, not the scanner's: a
// patient-facing writer mislabelled `staff` would pass. What the scanner
// guarantees is that no writer is absent and none is silently added.

import fs from 'node:fs';
import path from 'node:path';

import {
  SRC_DIR,
  callArgumentText,
  callSites,
  insertIntoTable,
  isOnCommentLine,
  ormModelCalls,
  readSource,
  scanDispatchSites,
  scanMechanismCounts,
  scanOrmRowWrites,
  typeLiteralsFrom,
  updateTable,
  walkSources,
} from '../helpers/notificationSourceScan.js';
import {
  feedRowTypeForTransportType,
  __testing__,
} from '../../utils/notifications/tenantNotificationChannels.js';
import {
  PATIENT_INBOX_NOTIFICATION_TYPES,
} from '../../config/patientNotificationTypeRegistry.js';

const INBOX_SCREEN = path.resolve(
  SRC_DIR, '..', '..', 'patient',
  'lib', 'features', 'notifications', 'screens', 'notifications_screen.dart',
);

// ── the routed set, generated into Flutter from the backend registry ──────

const INBOX_SOURCE = fs.readFileSync(INBOX_SCREEN, 'utf8');
const ROUTED_TYPES = new Set(PATIENT_INBOX_NOTIFICATION_TYPES);

/**
 * Assert that every string a call site's `type:` properties can carry is a
 * routed one. Fails on three distinct things, each with the label in the
 * message: an expression this cannot decide from source (a variable, a
 * template literal, a lookup), a call with no `type` at all, and a decidable
 * type the inbox does not route. Returns the resolved literals.
 */
function expectRoutedTypes(label, text) {
  const { literals, unresolved } = typeLiteralsFrom(text);
  // A type this cannot resolve is not a pass. Make it a literal (or a
  // conditional between literals), or write the row through a dispositioned
  // direct INSERT whose slot resolution can follow it.
  expect({ label, unresolved }).toEqual({ label, unresolved: [] });
  expect({ label, hasType: literals.length > 0 }).toEqual({ label, hasType: true });
  for (const literal of literals) {
    expect({ label, type: literal, routed: ROUTED_TYPES.has(literal) })
      .toEqual({ label, type: literal, routed: true });
  }
  return literals;
}

// ── 1. helper call sites (fully mechanical) ───────────────────────────────

function helperCallSites() {
  const sites = [];
  walkSources((file, source) => {
    for (const name of [
      'recordPatientFeedNotification',
      'recordPatientFeedNotificationWithReceipt',
    ]) {
      for (const openParen of callSites(source, name)) {
        sites.push({ file, text: callArgumentText(source, openParen) });
      }
    }
  });
  return sites;
}

// ── 2. direct INSERT INTO notifications writers ───────────────────────────

/**
 * Dispositions:
 *   patient    the row lands in a patient's inbox — its type MUST be routed,
 *              and is resolved out of the statement (see below)
 *   staff      recipient is staff; the staff app reads these, not the patient
 *   operator   operator-authored broadcast/announcement whose BODY is the whole
 *              message; there is no feature destination to route to, and the
 *              types are uppercased free text that the patient contract
 *              deliberately treats as non-actionable
 *   infra      the shared writers themselves — the type is a parameter, and
 *              the callers that supply it are scanned by mechanism 1 (the feed
 *              helper) and mechanism 3 (the dispatcher)
 *
 * A `patient` entry declares EITHER `types` (the literal set its type slot
 * resolves to) or `typeFrom` (the exported function whose `type` parameter the
 * slot resolves to, plus the literal set its call sites pass).
 */
const NOTIFICATION_ROW_WRITERS = Object.freeze({
  'services/clinical/drugChartSlaService.js': { sites: 1, disposition: 'staff' },
  'services/feedback/feedbackService.js': { sites: 1, disposition: 'staff' },
  // notifyPatientResultRecipients takes `type` from its caller: the INSERT's
  // type slot is `$6`, which is the `type` parameter. Both callers are scanned.
  'services/lab/labResultsService.js': {
    sites: 1,
    disposition: 'patient',
    typeFrom: 'notifyPatientResultRecipients',
    types: ['lab_result_corrected', 'lab_result_ready'],
  },
  'services/notification/adminNotificationService.js': { sites: 4, disposition: 'operator' },
  'services/notification/notificationService.js': { sites: 2, disposition: 'operator' },
  'services/notification/staffNotificationService.js': { sites: 1, disposition: 'staff' },
  'services/portal/patientPortalService.js': {
    sites: 1,
    disposition: 'patient',
    types: ['patient_message'],
  },
  'services/sosService.js': { sites: 1, disposition: 'staff' },
  'services/staff/onCallRosterService.js': { sites: 2, disposition: 'staff' },
  'services/staff/rosterBoardService.js': { sites: 1, disposition: 'staff' },
  'services/staff/rosterDeadlineService.js': { sites: 1, disposition: 'staff' },
  'services/staff/shiftSwapService.js': { sites: 1, disposition: 'staff' },
  'utils/notifications/InvestigationNotificationJob.js': {
    sites: 1,
    disposition: 'patient',
    types: ['investigation_result'],
  },
  'utils/notifications/notificationDispatcher.js': { sites: 1, disposition: 'infra' },
  'utils/notifications/patientNotificationFeed.js': { sites: 1, disposition: 'infra' },
});

/** Raw-SQL call forms Prisma exposes; the INSERT always sits in one of them. */
const RAW_SQL_CALL = /\.\$(?:query|execute)Raw(?:Unsafe)?\s*\(/g;

/** Split a comma-separated list at depth 0, string- and bracket-aware. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      current += ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { current += text.slice(i, i + 2); i += 2; continue; }
        current += text[i];
        if (text[i] === ch) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; i += 1; continue; }
    current += ch;
    i += 1;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Text between the paren at `openIndex` and its match, or null. */
function insideParens(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") { i += 1; while (i < text.length && text[i] !== "'") i += 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * Resolve what each `INSERT INTO notifications` in `file` binds to the `type`
 * column. Returns one entry per statement:
 *   { kind: 'literal',    value }  a quoted string, in the SQL or a bind arg
 *   { kind: 'identifier', value }  a bare identifier bind arg (a parameter)
 *   { kind: 'unresolved', value }  anything this parser cannot follow
 * Unresolved is a FAILURE for a `patient` writer, never a pass.
 */
function resolveTypeSlots(file) {
  const source = readSource(file);
  const slots = [];
  for (const match of source.matchAll(RAW_SQL_CALL)) {
    if (isOnCommentLine(source, match.index)) continue;
    const openParen = match.index + match[0].length - 1;
    const text = callArgumentText(source, openParen);
    // Same spellings the mechanism scan accepts — bare, schema-qualified,
    // quoted. If this narrowed to the bare form while scanNotificationRowWriters
    // did not, a `public.notifications` writer would be counted by the set
    // equality above and then silently skipped here, and `slots.length` would
    // fail with a message about nothing in particular.
    if (!text || !insertIntoTable('notifications', { flags: 'i' }).test(text)) continue;
    const args = splitTopLevel(text);
    const sql = args[0] || '';
    const columnsAt = sql.search(insertIntoTable('notifications', { flags: 'i', suffix: '\\s*\\(' }));
    const columnList = columnsAt < 0 ? null : insideParens(sql, sql.indexOf('(', columnsAt));
    const valuesAt = sql.search(/VALUES\s*\(/i);
    const valueList = valuesAt < 0 ? null : insideParens(sql, sql.indexOf('(', valuesAt));
    if (columnList === null || valueList === null) {
      slots.push({ kind: 'unresolved', value: 'column or VALUES list not parseable', at: openParen });
      continue;
    }
    const columns = columnList.split(',').map((column) => column.trim());
    const index = columns.indexOf('type');
    const values = splitTopLevel(valueList);
    const slot = index < 0 ? null : values[index];
    slots.push({ ...resolveSlotExpression(slot, args), at: openParen });
  }
  return slots;
}

function resolveSlotExpression(slot, args) {
  if (!slot) return { kind: 'unresolved', value: 'no VALUES entry opposite the type column' };
  const literal = slot.match(/^'([^']*)'(?:::\w+)?$/);
  if (literal) return { kind: 'literal', value: literal[1] };
  const bind = slot.match(/^\$(\d+)(?:::\w+)?$/);
  if (!bind) return { kind: 'unresolved', value: slot };
  const arg = args[Number(bind[1])];
  if (arg === undefined) return { kind: 'unresolved', value: `${slot} has no bind argument` };
  const argLiteral = arg.match(/^'([^']*)'$/);
  if (argLiteral) return { kind: 'literal', value: argLiteral[1] };
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) return { kind: 'identifier', value: arg };
  return { kind: 'unresolved', value: arg };
}

function scanNotificationRowWriters() {
  const found = {};
  for (const [file, counts] of Object.entries(scanMechanismCounts(['rowInsert']))) {
    found[file] = counts.rowInsert;
  }
  return found;
}

/** Every call site of `name` under src/, with its argument text. */
function callSitesAcrossSources(name) {
  const sites = [];
  walkSources((file, source) => {
    for (const openParen of callSites(source, name)) {
      sites.push({ file, text: callArgumentText(source, openParen) });
    }
  });
  return sites;
}

// ── 3. dispatch() / dispatchToPatient() call sites ────────────────────────

/**
 * Keyed `file#<0-based occurrence>`. Only `patient` sites are constrained.
 * `infra` covers the dispatcher's own forwarder and the outbox drain; the two
 * function declarations are not call sites and the scanner excludes them.
 */
const DISPATCH_SITES = Object.freeze({
  // Prescription ready → the patient's inbox. channels include 'inapp'.
  'controllers/prescription/ePrescriptionController.js#0': 'patient',
  // "Notify pharmacy staff" — userId is the literal 'pharmacy', which resolves
  // to no user, so no row is written at all (the comment there says so).
  'controllers/prescription/ePrescriptionController.js#1': 'staff',
  // CRITICAL vital alert to `alert.recorded_by`, the recording clinician.
  'utils/clinical/vitalSignMonitor.js#0': 'staff',
  // dispatchToPatient()'s own call into dispatch().
  'utils/notifications/notificationDispatcher.js#0': 'infra',
  'utils/notifications/notificationOutboxDelivery.js#0': 'infra',
});

// ── 4. ORM row writers ────────────────────────────────────────────────────

/**
 * Prisma WRITE sites on the `notifications` model — the `create` family, the
 * `update` family and `upsert` — keyed the same way. `patient` sites must pass
 * a routed literal type; `staff` sites feed the staff app's own list. Every
 * live site is a `create` today; the scanner covers the rest so that stops
 * being true loudly rather than silently.
 */
const ORM_ROW_WRITERS = Object.freeze({
  // Investigation ordered → /investigations. Was 'investigation_ordered',
  // which the tap handler has no case for.
  'services/investigation/orderService.js#0': 'patient',
  // Legacy investigation report ready → /investigations. Was
  // 'investigation_ready', likewise unrouted.
  'services/investigation/orderService.js#1': 'patient',
  // Supervisor's leave-approval request.
  'services/staff/hr/leaveService.js#0': 'staff',
  // The reviewed staff member's own review outcome.
  'services/staff/hr/performanceService.js#0': 'staff',
});

// ── 5. outbox types that can become a dispatcher-written row ──────────────

/**
 * Every key of TYPE_TO_PREFERENCE_KEY is a type whose channel set a tenant can
 * configure, so any of them can arrive at dispatch() with `inapp` and become a
 * `notifications` row. Those that are not patient inbox types are listed here
 * with why; everything else must resolve to a routed type.
 *
 * This is the complete set for a reason worth writing down, because
 * `resolveChannelsForOutboxRow` has a second door: a row whose payload carries
 * `__delivery_channels` gets those channels whatever its type. Only one caller
 * ever sets them — `notificationOutboxAdminService`'s operator requeue — and it
 * derives them from the ORIGINAL row's rejected delivery attempts and copies
 * `row.type` verbatim, so it can re-send a type but never introduce one.
 */
const NON_PATIENT_INBOX_OUTBOX_TYPES = Object.freeze({
  // resolveChannelsForOutboxRow returns ['inapp'] for this unconditionally,
  // but the recipient is a staff uid and the staff app has its own inbox.
  payslip_ready: 'staff — payslipService queues these to staff_uid',
});

// ── assertions ────────────────────────────────────────────────────────────

describe('patient inbox tap handler', () => {
  it('uses the generated action contract as its only routing vocabulary', () => {
    expect(ROUTED_TYPES.size).toBeGreaterThan(10);
    expect(INBOX_SOURCE).toContain('patient_notification_contract.g.dart');
    expect(INBOX_SOURCE).toContain('patientNotificationContractFor(type)');
    expect(INBOX_SOURCE).not.toContain('switch (type)');
    expect(ROUTED_TYPES.has('lab_result_ready')).toBe(true);
    expect(ROUTED_TYPES.has('appointment_reminder')).toBe(true);
    expect(ROUTED_TYPES.has('patient_message')).toBe(true);
    expect(ROUTED_TYPES.has('engagement_campaign')).toBe(true);
  });

  it('does not route the transport-only reminder types', () => {
    // The reason feedRowTypeForTransportType exists. If the app ever adds
    // these as cases, that mapping becomes redundant rather than wrong.
    expect(ROUTED_TYPES.has('appointment_reminder_24h')).toBe(false);
    expect(ROUTED_TYPES.has('appointment_reminder_1h')).toBe(false);
  });
});

describe('a row type is set at INSERT and never rewritten', () => {
  // Schema-qualified and quoted spellings included, for the same reason the
  // INSERT side takes them: a retyping `UPDATE public.notifications` would
  // otherwise walk straight past the assertion that makes resolving the INSERT
  // mean anything.
  const UPDATE_NOTIFICATIONS = updateTable('notifications', {
    suffix: '[\\s\\S]{0,400}?\\bSET\\b([\\s\\S]{0,400}?)(?:WHERE|RETURNING|`|\')',
  });

  it('has no UPDATE that assigns notifications.type', () => {
    // The whole gate resolves types at the INSERT. If something could retype a
    // row afterwards, resolving the INSERT would prove nothing — so that is
    // asserted rather than assumed.
    const offenders = [];
    walkSources((file, source) => {
      for (const match of source.matchAll(UPDATE_NOTIFICATIONS)) {
        if (/(^|[\s,])type\s*=/i.test(match[1])) offenders.push(file);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('has no Prisma update that can retype a notifications row', () => {
    // The ORM twin of the assertion above. `notifications.update(...)` is
    // classified `retypes` by the scanner, so it appears as an `orm` site in
    // the census and has to be dispositioned there; here we state the stronger
    // fact that no such call exists at all, which is what lets the routing
    // gate resolve a row's type once, at its INSERT.
    const offenders = {};
    walkSources((file, source) => {
      const retypes = ormModelCalls(source)
        .filter((call) => call.effect === 'retypes')
        .map((call) => call.method);
      if (retypes.length > 0) offenders[file] = retypes;
    });
    expect(offenders).toEqual({});
  });
});

describe('recordPatientFeedNotification call sites', () => {
  const sites = helperCallSites();

  it('finds every call site with balanced parens', () => {
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(site.text).not.toBeNull();
  });

  it.each(sites.map((site, index) => [`${site.file}#${index}`, site]))(
    '%s passes a decidable, routed type',
    (label, site) => {
      expectRoutedTypes(label, site.text);
    },
  );
});

describe('direct INSERT INTO notifications writers', () => {
  it('accounts for every writer and every site', () => {
    const declared = Object.fromEntries(
      Object.entries(NOTIFICATION_ROW_WRITERS).map(([file, entry]) => [file, entry.sites]),
    );
    expect(scanNotificationRowWriters()).toEqual(declared);
  });

  const patientWriters = Object.entries(NOTIFICATION_ROW_WRITERS)
    .filter(([, entry]) => entry.disposition === 'patient');

  it.each(patientWriters)('%s resolves its type slot to a routed value', (file, entry) => {
    const slots = resolveTypeSlots(file);
    expect(slots.length).toBe(entry.sites);
    for (const slot of slots) {
      // Never let an unparseable statement pass as "no problem found".
      expect({ file, kind: slot.kind, value: slot.value })
        .toEqual({ file, kind: entry.typeFrom ? 'identifier' : 'literal', value: slot.value });
    }
    if (entry.typeFrom) {
      // The slot is a parameter: prove it is THAT function's parameter, that
      // the INSERT is inside it, and then check every caller.
      const source = readSource(file);
      const declaration = source.search(
        new RegExp(`\\bfunction\\s+${entry.typeFrom}\\s*\\(\\s*\\{[^}]*\\btype\\b`),
      );
      expect(declaration).toBeGreaterThanOrEqual(0);
      for (const slot of slots) {
        expect(slot.value).toBe('type');
        expect(slot.at).toBeGreaterThan(declaration);
        // …and before whatever is exported next, so the INSERT cannot be in a
        // later function that merely happens to have a `type` variable.
        const nextExport = source.indexOf('\nexport ', declaration + 1);
        expect(nextExport === -1 || slot.at < nextExport).toBe(true);
      }
      const callers = callSitesAcrossSources(entry.typeFrom);
      expect(callers.length).toBeGreaterThan(0);
      const passed = new Set();
      for (const caller of callers) {
        for (const literal of expectRoutedTypes(caller.file, caller.text)) {
          passed.add(literal);
        }
      }
      // The declared set is the scanned set — no more, no fewer.
      expect([...passed].sort()).toEqual([...entry.types].sort());
    } else {
      expect(slots.map((slot) => slot.value).sort())
        .toEqual([...entry.types].sort());
    }
    for (const type of entry.types) {
      expect({ type, routed: ROUTED_TYPES.has(type) }).toEqual({ type, routed: true });
    }
  });
});

describe('dispatch() call sites that write an in-app row', () => {
  const scanned = scanDispatchSites();

  it('accounts for every dispatch call site', () => {
    expect(Object.keys(scanned).sort()).toEqual(Object.keys(DISPATCH_SITES).sort());
  });

  it.each(
    Object.entries(DISPATCH_SITES).filter(([, disposition]) => disposition === 'patient'),
  )('%s dispatches a routed type', (key) => {
    const text = scanned[key];
    expect(text).not.toBeNull();
    // Only an `inapp` dispatch writes a row; assert that is what this is, so
    // the routing claim below is about something that actually gets written.
    expect(text).toMatch(/channels:\s*\[[^\]]*'inapp'/);
    expectRoutedTypes(key, text);
  });
});

describe('Prisma write sites on the notifications model', () => {
  const scanned = scanOrmRowWrites();

  it('accounts for every ORM row-write site', () => {
    expect(Object.keys(scanned).sort()).toEqual(Object.keys(ORM_ROW_WRITERS).sort());
  });

  it.each(
    Object.entries(ORM_ROW_WRITERS).filter(([, disposition]) => disposition === 'patient'),
  )('%s writes a routed type', (key) => {
    const text = scanned[key];
    expect(text).not.toBeNull();
    expectRoutedTypes(key, text);
  });
});

describe('outbox types that the drain can turn into an in-app row', () => {
  const configurableTypes = [...__testing__.TYPE_TO_PREFERENCE_KEY.keys()];

  it('covers every tenant-configurable type', () => {
    expect(configurableTypes.length).toBeGreaterThan(0);
  });

  it.each(
    configurableTypes.filter((type) => !(type in NON_PATIENT_INBOX_OUTBOX_TYPES)),
  )(
    '%s reaches the inbox as a routed type',
    (type) => {
      const feedType = feedRowTypeForTransportType(type);
      expect({ type, feedType, routed: ROUTED_TYPES.has(feedType) })
        .toEqual({ type, feedType, routed: true });
    },
  );

  it('keeps the non-patient exception list from growing silently', () => {
    expect(Object.keys(NON_PATIENT_INBOX_OUTBOX_TYPES).sort()).toEqual([
      'payslip_ready',
    ]);
    // Every exception must still be a real key of the map it excepts from.
    for (const type of Object.keys(NON_PATIENT_INBOX_OUTBOX_TYPES)) {
      expect(configurableTypes).toContain(type);
    }
  });

  it('translates only types the inbox does not already route', () => {
    for (const [transport, feed] of __testing__.TRANSPORT_TYPE_TO_FEED_TYPE) {
      expect(ROUTED_TYPES.has(transport)).toBe(false);
      expect(ROUTED_TYPES.has(feed)).toBe(true);
    }
  });
});
