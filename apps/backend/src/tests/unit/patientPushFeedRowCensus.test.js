// Census gate: every PATIENT-facing push emitter must also write the in-app
// `notifications` feed row that the push points at.
//
// WHY THIS IS A SOURCE ASSERTION. `sendPushNotification` replaces the whole
// data payload of every NORMAL-priority message with
// `createPrivatePushEnvelope()` — `{ notification_id, route: '/notifications',
// action, click_action }` — and replaces the FCM notification block with a
// generic "You have a new update. Open the app to view it."
// (sendPushNotification.js:36-43, :116-135). By design the push carries no
// readable content and no feature deep link, so the feed row is not a nice
// extra: it IS the message. An emitter that pushes without writing one buzzes
// the patient into an empty inbox, and nothing about that fails, logs, or
// shows up in any single-path integration test — the push succeeds.
//
// ── THE COMPLETENESS CONTRACT ─────────────────────────────────────────────
//
// Twice now this gate has been widened because a whole MECHANISM was invisible
// to it: the first version enumerated files that call `sendPushNotification`
// plus two hand-picked outbox emitters and missed
// `investigationService.addResults`; the second scanned three mechanisms and
// could not see `dispatch()` or `prisma.notifications.create`. So the contract
// is stated as an exhaustive list — but of a NARROWED subject, because the
// earlier wording ("a patient notification can come into existence in SIX
// ways") was simply false against the tree. `paymentLinkService` reaches a
// patient by WhatsApp at services/billing/paymentLinkService.js:475 and by
// email at :484, and neither is one of the six. What follows is what this gate
// does cover, and then, in its own section, what it does not.
//
// ── WHAT IS COVERED ───────────────────────────────────────────────────────
//
// A notification that lands INSIDE THE PATIENT APP — as a privacy-stripped
// push, or as a `notifications` feed row, or as both — can come into existence
// in SIX ways, and those six are scanned.
//
//   FOUR can produce a privacy-stripped push. Pushing never writes the feed
//   row — only an explicit `inapp` channel, or an explicit row write, does — so
//   these four are where the empty-inbox buzz comes from and are what this gate
//   scans, counting CALL SITES rather than files, set-equal in both directions:
//
//     1. `push`     — a direct `sendPushNotification(...)` call.
//     2. `queue`    — `notificationOutbox.queue(...)` / `outbox.queue(...)`.
//                     The drain turns the intent into the same stripped push
//                     whenever the resolved channel set contains `push`, and
//                     writes a feed row ONLY when it contains `inapp` (which
//                     the default legacy resolution never does).
//     3. `raw`      — a raw `INSERT INTO notification_outbox`, in any spelling
//                     of that table, that bypasses `queue()` entirely. FOUR
//                     services do this —
//                     stemiPathwayService and breachService (staff),
//                     diagnosticResultPatientNotificationService and
//                     referralClosedLoopService (patient) — plus the outbox
//                     core itself, which is what `queue()` is. The count is
//                     five files, and the table below is the authority on it;
//                     this line is a summary, not a second declaration.
//     4. `dispatch` — `dispatch(...)` / `dispatchToPatient(...)`. This one
//                     branches: with `inapp` among the channels the dispatcher
//                     writes the row itself (disposition `patient-inapp`, and
//                     the channel list is asserted to really contain it);
//                     without it, the caller owes the row like any other
//                     pusher.
//
//   TWO are row writes rather than sends: they put a row in the inbox and
//   transmit nothing themselves, so "did it write the row" is true by
//   construction and the obligation that actually bites them is that the row's
//   TYPE must be one the patient app routes:
//
//     5. `orm`       — a Prisma WRITE on the `notifications` model: the
//                      `create` family, `upsert`, and the `update` family,
//                      which does not create a row but can re-type one. All
//                      four live sites are `create` today; the scanner covers
//                      the rest because it matches the MODEL and classifies
//                      the METHOD (ORM_METHOD_EFFECTS) rather than pinning
//                      method names into a regex, which is how `upsert`,
//                      `createManyAndReturn` and every `update` were invisible
//                      to both gates until 2026-08-24. Scanned and
//                      dispositioned here so a new one cannot appear
//                      unaccounted (the patient-facing ones are
//                      `patient-row-only`; the two HR ones are `staff`), and
//                      the types themselves are checked by
//                      patientInboxTypeRouting.test.js.
//     6. rowInsert   — a raw `INSERT INTO notifications`, in any spelling
//                      Postgres accepts for that table: bare, schema-qualified
//                      (`public.notifications`) or quoted (`"notifications"`).
//                      NOT in the table below: it is enumerated with the same
//                      both-directions set equality by NOTIFICATION_ROW_WRITERS
//                      in patientInboxTypeRouting.test.js, and listing the same
//                      fifteen files in two tables is how tables rot. It is
//                      counted here only as evidence that a file writes rows.
//
// The mechanism patterns live in one place — src/tests/helpers/
// notificationSourceScan.js — so a mechanism is declared once and both gates
// draw from the same declaration rather than each keeping its own copy, which
// is how they came to disagree about what a call site was.
//
// The "does it write the row" half is computed from source too — the number of
// feed-row writes in the file must be at least the number of `patient` sites
// in it — not restated as a hand-made pass list.
//
// ── WHAT IS NOT COVERED, AND SAID PLAINLY ─────────────────────────────────
//
// A transport called DIRECTLY, outside the outbox and outside the dispatcher,
// is not one of the six and is not scanned for a feed row:
// `sendWhatsApp(...)`, `sendEmail(...)`, `sendSMS(...)`.
//
// That exclusion is deliberate and it is narrow. The entire premise of this
// gate is that `sendPushNotification` strips the payload, so the feed row IS
// the message; a WhatsApp message or an email carries its own readable body,
// so there is no stripped envelope and no empty inbox to land in. The same
// reasoning already has a name in the table below — `patient-readable`, used
// for the two `queue()` sites whose channel is `sms`.
//
// What this gate does NOT say about those channels: nothing at all. This lane
// did not audit their content, their consent, their opt-out handling, their
// delivery evidence, or whether a patient who gets one can find it again.
// `paymentLinkService` sending a payment link over WhatsApp is outside this
// census, not blessed by it.
//
// The call sites are still ENUMERATED, in DIRECT_TRANSPORT_SITES below, with
// the same both-directions set equality. That is a boundary marker, not an
// audit: it exists so a NEW direct-transport reach cannot appear without
// someone stating which side of the line it is on.
//
// TO ADD A NEW PATIENT-FACING EMITTER: add its site to the table with the
// `patient` disposition, and make it write the feed row (normally via
// `recordPatientFeedNotification`). For a STAFF-facing one, use `staff` —
// staff surfaces have their own inbox (staffNotificationService) and their
// pushes are not the patient privacy envelope's problem.

import {
  MECHANISM_PATTERNS,
  callSites,
  dispatchCallSites,
  insertIntoTable,
  ormRowCreations,
  ormWriteCalls,
  readSource,
  scanDispatchSites,
  scanMechanismCounts,
  scanUnclassifiedOrmMethods,
  walkSources,
} from '../helpers/notificationSourceScan.js';

/**
 * Dispositions. Only `patient` obliges the file to write a feed row.
 *
 *  definition        the transport function itself
 *  infrastructure    dispatcher / outbox core / drain / the feed-row helper
 *  transport-retry   re-sends an intent another emitter already owns
 *  staff             recipient is staff; the staff app has its own inbox
 *  patient           privacy-stripped push to a patient — MUST write the row
 *  patient-inapp     dispatch() to a patient WITH `inapp` among the channels:
 *                    the dispatcher writes the row on the caller's behalf, so
 *                    the caller owes nothing — asserted by checking the
 *                    channel list really contains 'inapp'
 *  patient-row-only  writes the patient's inbox row directly and sends no
 *                    push at all; the row-existence obligation is satisfied by
 *                    construction and the type obligation lives in
 *                    patientInboxTypeRouting.test.js
 *  patient-readable  patient intent on a channel that carries its own text
 *                    (sms / print), so there is no stripped-envelope problem
 */
const EMITTERS = Object.freeze({
  // ── infrastructure ────────────────────────────────────────────────────
  'utils/notifications/sendPushNotification.js': { push: ['definition'] },
  // dispatch()'s `inapp` channel writes the feed row itself; its two queue()
  // sites record `sms` / `print` intents on behalf of a caller. The one
  // `dispatch` site here is `dispatchToPatient`'s forwarding call — the two
  // function declarations are not call sites and are excluded by the scanner.
  'utils/notifications/notificationDispatcher.js': {
    push: ['infrastructure'],
    queue: ['infrastructure', 'infrastructure'],
    dispatch: ['infrastructure'],
  },
  'utils/notifications/notificationOutbox.js': { raw: ['infrastructure'] },
  'utils/notifications/notificationOutboxDelivery.js': {
    push: ['infrastructure'],
    dispatch: ['infrastructure'],
  },
  // Operator-driven requeue of an existing row; it copies `row.type` and the
  // original emitter already owns (or does not own) the feed row. This is also
  // the only caller that sets `deliveryChannels`, and it derives them from the
  // original row's rejected delivery attempts (falling back to `row.channel`
  // when there are none) rather than choosing new ones.
  'services/notification/notificationOutboxAdminService.js': { queue: ['infrastructure'] },
  // Two sites. `sendPushWithRetry` has no production caller (only tests import
  // it). `retryFailedNotifications` IS a live cron — scheduler.js:767, every
  // 5 min under withJobLock — but it re-sends rows from `failed_notifications`,
  // a table only those two un-called helpers write. Either way both sites are
  // pure transport re-send: the original emitter owns the feed row.
  'services/notificationRetryService.js': { push: ['transport-retry', 'transport-retry'] },

  // ── staff-facing (own inbox, not the patient privacy envelope) ────────
  // sendUrgentAlert → resolveStaffPushRecipients(URGENT_ALERT_ROLES).
  'controllers/investigation/orderController.js': { push: ['staff'] },
  // Fan-out over `users WHERE role IN ('ADMIN','SUPER_ADMIN')`.
  'utils/notifications/stuckOrderEscalation.js': { push: ['staff'] },
  // Code Blue is priority:'high', so it is NOT privacy-stripped at all.
  'utils/websocket/realtimeEmitter.js': { push: ['staff'] },
  // CRITICAL vital alert dispatched to `alert.recorded_by`, the recording
  // clinician, with channels ['push','inapp'].
  'utils/clinical/vitalSignMonitor.js': { dispatch: ['staff'] },
  'services/ai/operationalAlertService.js': { queue: ['staff'] },
  'services/ai/virtualWardService.js': { queue: ['staff'] },
  // Finance recovery roles (FINANCE_INCHARGE / BILLING_INCHARGE / ADMIN /
  // SUPER_ADMIN), then the finance-role in-app queue for the same case.
  'services/billing/gatewayRefundRecoveryService.js': { queue: ['staff', 'staff'] },
  // GATEWAY_REFUND_RECONCILIATION_ROLES = SUPER_ADMIN / ADMIN.
  'services/billing/paymentGatewayService.js': { queue: ['staff'] },
  'services/biomed/biomedCmmsService.js': { queue: ['staff'] },
  // MED-03 753 shortfall notice; its recipient must be backed by a pharmacy
  // facility grant, so it can only ever be staff.
  'services/clinical/cathLabService.js': { queue: ['staff'] },
  // Blood-borne reuse exposure notice, fanned out over
  // `users WHERE role = 'INFECTION_CONTROL_OFFICER'` — never the patient.
  'services/clinical/cathDeviceReuseService.js': { queue: ['staff'] },
  // Clinician delivery obligation, then the overdue recovery escalation — both
  // to the alert's clinical roster.
  'services/clinical/clinicalAlertDeliveryObligationService.js': { queue: ['staff', 'staff'] },
  // Prescriber review of a held/missed dose: raised, overdue escalation, and
  // the administrator reassignment handoff.
  'services/clinical/marMedicationExceptionService.js': {
    queue: ['staff', 'staff', 'staff'],
  },
  // Ward indent obligations, the credit-note finance review, and the MAR
  // supply reconciliation notice — all ward / pharmacy / finance staff.
  'services/ipd/wardIndentObligationService.js': {
    queue: ['staff', 'staff', 'staff', 'staff', 'staff'],
  },
  'services/devices/coldChainService.js': { queue: ['staff'] },
  'services/feedback/npsService.js': { queue: ['staff'] },
  'services/insurance/claimsService.js': { queue: ['staff'] },
  'services/maternity/maternityService.js': { queue: ['staff'] },
  'services/messaging/messagingService.js': { queue: ['staff'] },
  'services/patientFlow/porterTransportService.js': { queue: ['staff'] },
  'services/staff/credentialingService.js': { queue: ['staff'] },
  // Both payslip intents are channel:'inapp' to a staff uid; `payslip_ready`
  // resolves ['inapp'] unconditionally, so the drain writes the staff row.
  'services/staff/payrollService.js': { queue: ['staff', 'staff'] },
  'services/workflow/escalationEngineService.js': { queue: ['staff'] },
  'utils/notifications/clinicalAlertFanout.js': { queue: ['staff'] },
  'services/clinical/stemiPathwayService.js': { raw: ['staff'] },
  'services/compliance/breachService.js': { raw: ['staff'] },
  // Supervisor leave-approval request / reviewed staff member's own review
  // outcome. Both write a `notifications` row for a staff user_id.
  'services/staff/hr/leaveService.js': { orm: ['staff'] },
  'services/staff/hr/performanceService.js': { orm: ['staff'] },

  // ── patient, transport carries its own readable text ──────────────────
  // type:'sms' → legacyChannelsForOutboxRow returns ['sms']; the SMS body is
  // the message, so there is no empty-inbox landing to fix.
  'services/discharge/dischargeService.js': { queue: ['patient-readable'] },
  'utils/notifications/smsOutbox.js': { queue: ['patient-readable'] },

  // ── patient-facing: must write the feed row ───────────────────────────
  'controllers/appointment/appointmentCrudController.js': { push: ['patient'] },
  'controllers/appointment/appointmentDocumentController.js': { push: ['patient'] },
  'controllers/appointment/appointmentWorkflowController.js': { push: ['patient', 'patient'] },
  // Site order in file: lab-staff alert (:309), then booking confirmed,
  // collector dispatched, result ready.
  'controllers/investigation/bookingController.js': {
    push: ['staff', 'patient', 'patient', 'patient'],
  },
  // MED-03 delivery custody. Site order in file: dispatch (patient handoff,
  // patient SMS, courier assignment), delivery completed (patient), handoff
  // reissue (patient handoff, patient SMS, courier assignment), return
  // requested (patient, return owner), return completed (patient).
  //
  // Every `pharmacy_delivery_*` transport type is outside the patient registry,
  // so resolveChannelsForOutboxRow finds no preference key and falls back to
  // the legacy ['push'] set — the drain never writes the row for these. The
  // patient sites therefore owe it themselves, and the handoff ones especially:
  // the one-time code is in the body the stripped envelope throws away. The
  // `type: 'sms'` intents are readable text and owe nothing.
  'controllers/pharmacy/pharmacyOrderController.js': {
    queue: [
      'patient', 'patient-readable', 'staff',
      'patient',
      'patient', 'patient-readable', 'staff',
      'patient', 'staff',
      'patient',
    ],
  },
  'services/portal/patientPortalService.js': { push: ['patient'] },
  'utils/notifications/InvestigationNotificationJob.js': { push: ['patient'] },
  // Reminder intents (24h/1h) + the scheduled-notification sweep.
  'utils/notifications/appointmentReminderJob.js': { queue: ['patient', 'patient'] },
  // Site order: critical-result alert to lab/clinical staff (:1606), then the
  // patient/guardian result-ready intent inside notifyPatientResultRecipients.
  'services/lab/labResultsService.js': { queue: ['staff', 'patient'] },
  // SAFE-01: unmatched-threshold exception notice to the assignee or the
  // exception role's holders (`role <> 'PATIENT'` in its recipient query,
  // audience-bounded, in-app only) — never the patient.
  'services/lab/labThresholdExceptionService.js': { queue: ['staff'] },
  'services/investigation/investigationService.js': { queue: ['patient'] },
  // Site order: prescription-ready to the patient with channels
  // ['push','inapp'] — the dispatcher commits the row — then the pharmacy-staff
  // notice whose userId is the literal 'pharmacy', which resolves to no user,
  // so no row is written at all (the comment there says so).
  'controllers/prescription/ePrescriptionController.js': {
    dispatch: ['patient-inapp', 'staff'],
  },

  // ── patient-facing, writes the inbox row directly, sends nothing ──────
  // Order-placed notice, then the legacy report-ready notice. Both are
  // `prisma.notifications.create` with no push anywhere in the file.
  'services/investigation/orderService.js': { orm: ['patient-row-only', 'patient-row-only'] },

  // These three emitters now persist the readable patient feed row in the
  // same tenant transaction as their outbox intent. The outbox carries the
  // committed row id so an `inapp` delivery receipts it rather than inserting
  // a duplicate.
  'services/diagnostics/diagnosticResultPatientNotificationService.js': {
    raw: ['patient'],
  },
  'services/referral/referralClosedLoopService.js': { raw: ['patient'] },
  'services/engagement/engagementCampaignService.js': { queue: ['patient'] },
});

/**
 * THE BOUNDARY, NOT AN AUDIT. Every direct call to a readable-text transport
 * under src/ — `sendWhatsApp(...)`, `sendEmail(...)`, `sendSMS(...)`. None of
 * these is one of the six mechanisms, none is checked for a feed row, and this
 * lane did not audit what they send or to whom. They are enumerated with the
 * same both-directions set equality as the census itself so that a NEW direct
 * reach fails here and forces whoever adds it to say which side of the line it
 * is on, rather than quietly becoming a seventh way nobody named.
 *
 * The transport DEFINITIONS (`sendEmailNotification.js`,
 * `sendWhatsAppNotification.js`, `smsService.js`) are absent on purpose:
 * `callSites()` excludes a `function name(` declaration, so only callers land
 * here.
 *
 *  mechanism-transport  this IS how a scanned mechanism reaches the wire —
 *                       the dispatcher's per-channel sends and the outbox
 *                       drain's. Already accounted for as `dispatch`/`queue`.
 *  direct-patient       a caller that bypasses both, to an address read off
 *                       the patient record.
 *  direct-supplied      a caller that bypasses both, to an address the
 *                       operator or the calling workflow supplies.
 */
const DIRECT_TRANSPORT_SITES = Object.freeze({
  // :475 sendWhatsApp to `patient_phone`, :484 sendEmail to `patient_email` —
  // a bill amount and a `Pay now` link. Readable text, so no stripped
  // envelope; out of scope for this gate in both directions.
  'services/billing/paymentLinkService.js': ['direct-patient', 'direct-patient'],
  // Scheduled MIS report to `schedule.recipients`, an operator-configured list.
  'services/dashboards/misReportScheduleService.js': ['direct-supplied'],
  // The dispatcher's email / whatsapp / sms channels.
  'utils/notifications/notificationDispatcher.js': [
    'mechanism-transport', 'mechanism-transport', 'mechanism-transport',
  ],
  // The outbox drain's sms channel.
  'utils/notifications/notificationOutboxDelivery.js': ['mechanism-transport'],
});

/** The transport entry points DIRECT_TRANSPORT_SITES counts callers of. */
const DIRECT_TRANSPORTS = Object.freeze(['sendWhatsApp', 'sendEmail', 'sendSMS']);

/** Count-scanned mechanisms, in the order the table declares them. */
const COUNTED_MECHANISMS = Object.freeze(['push', 'queue', 'raw', 'orm']);
/** Every mechanism the table dispositions, including the site-indexed one. */
const MECHANISMS = Object.freeze([...COUNTED_MECHANISMS, 'dispatch']);

/**
 * A file writes the feed row if it inserts the row (raw SQL or ORM) or
 * delegates to the shared helper. Only ORM calls that CREATE a row count —
 * `notifications.update(...)` re-types a row that already exists and satisfies
 * nobody's obligation to write one.
 */
function countFeedRowWrites(source) {
  return (source.match(/recordPatientFeedNotification\s*\(/g) || []).length
    + (source.match(/recordPatientFeedNotificationWithReceipt\s*\(/g) || []).length
    + (source.match(MECHANISM_PATTERNS.rowInsert) || []).length
    + ormRowCreations(source).length;
}

/** `{ file: { mechanism: siteCount } }` across all five scanned mechanisms. */
function scanEmissionSites() {
  const found = scanMechanismCounts(COUNTED_MECHANISMS);
  walkSources((file, source) => {
    const sites = dispatchCallSites(source).length;
    if (sites > 0) found[file] = { ...(found[file] || {}), dispatch: sites };
  });
  return found;
}

/** `{ file: siteCount }` for every direct readable-text transport call. */
function scanDirectTransportSites() {
  const found = {};
  walkSources((file, source) => {
    const sites = DIRECT_TRANSPORTS.flatMap((name) => callSites(source, name)).length;
    if (sites > 0) found[file] = sites;
  });
  return found;
}

/** Declared site counts, in the same shape scanEmissionSites() returns. */
function declaredSiteCounts() {
  const declared = {};
  for (const [file, mechanisms] of Object.entries(EMITTERS)) {
    const counts = {};
    for (const mechanism of MECHANISMS) {
      const sites = mechanisms[mechanism];
      if (Array.isArray(sites) && sites.length > 0) counts[mechanism] = sites.length;
    }
    if (Object.keys(counts).length > 0) declared[file] = counts;
  }
  return declared;
}

function dispositionsFor(file, disposition) {
  const mechanisms = EMITTERS[file] || {};
  return MECHANISMS.flatMap((mechanism) => (mechanisms[mechanism] || []))
    .filter((value) => value === disposition);
}

function filesWith(disposition) {
  return Object.keys(EMITTERS).filter((file) => dispositionsFor(file, disposition).length > 0);
}

const scanned = scanEmissionSites();
const dispatchSites = scanDispatchSites();

describe('patient notification emission census', () => {
  it('accounts for every site that can start a patient push, by mechanism', () => {
    // Set equality in BOTH directions, plus per-mechanism counts. A new
    // emitter that is not in the table fails here rather than silently
    // shipping a dead-end buzz; a table entry whose call site was deleted
    // fails too, so the census cannot rot; and a SECOND site added to an
    // already-listed file fails on the count, which is the specific way the
    // first version of this census could be evaded.
    expect(scanned).toEqual(declaredSiteCounts());
  });

  it('uses only known dispositions', () => {
    const allowed = new Set([
      'definition', 'infrastructure', 'transport-retry', 'staff',
      'patient', 'patient-inapp', 'patient-row-only', 'patient-readable',
    ]);
    const used = new Set(
      Object.values(EMITTERS)
        .flatMap((mechanisms) => MECHANISMS.flatMap((m) => mechanisms[m] || [])),
    );
    for (const disposition of used) expect(allowed.has(disposition)).toBe(true);
  });

  it.each(filesWith('patient'))(
    '%s writes a feed row for each of its patient-facing sites',
    (file) => {
      const patientSites = dispositionsFor(file, 'patient').length;
      expect(countFeedRowWrites(readSource(file))).toBeGreaterThanOrEqual(patientSites);
    },
  );

  it.each(filesWith('patient-inapp'))(
    '%s really dispatches with `inapp` among its channels',
    (file) => {
      // The whole reason a `patient-inapp` site owes no row of its own is that
      // the dispatcher writes one for it, and it only does that when `inapp`
      // is in the channel list. Drop `inapp` and this site becomes an ordinary
      // patient push with no feed row — so the claim is checked, not asserted.
      const dispositions = EMITTERS[file].dispatch || [];
      dispositions.forEach((disposition, index) => {
        if (disposition !== 'patient-inapp') return;
        const text = dispatchSites[`${file}#${index}`];
        expect(text).not.toBeNull();
        expect(text).toMatch(/channels:\s*\[[^\]]*'inapp'/);
      });
    },
  );

  it.each(filesWith('patient-row-only'))(
    '%s writes the row it claims to and sends no push',
    (file) => {
      const source = readSource(file);
      const sites = dispositionsFor(file, 'patient-row-only').length;
      expect(countFeedRowWrites(source)).toBeGreaterThanOrEqual(sites);
      // `patient-row-only` means exactly that: no push, so no stripped
      // envelope, so no empty-inbox landing. Adding one to this file must
      // force a re-disposition rather than sliding through.
      expect(source.match(MECHANISM_PATTERNS.push)).toBeNull();
      expect(dispatchCallSites(source)).toEqual([]);
    },
  );

  it('has no patient notification dead-end disposition', () => {
    expect(filesWith('patient-open-no-row')).toEqual([]);
    expect(filesWith('patient-open-unrouted-type')).toEqual([]);
  });

  it('classifies every Prisma call it finds on the notifications model', () => {
    // The `orm` mechanism matches the MODEL and classifies the METHOD. A
    // method ORM_METHOD_EFFECTS has never seen is not assumed harmless — it
    // fails here, and the fix is one line in that map saying whether it
    // creates a row, can re-type one, or does neither. The regex it replaced
    // pinned `create`/`createMany` and so could not see `upsert(` at all.
    expect(scanUnclassifiedOrmMethods()).toEqual({});
  });
});

describe('direct readable-text transports — the boundary of this gate', () => {
  it('accounts for every direct sendWhatsApp/sendEmail/sendSMS call site', () => {
    // Both directions, like the census proper. This asserts only that the
    // boundary is where the header says it is: a new direct transport reach
    // cannot appear without being named, and a listed one that was deleted
    // fails too. It asserts NOTHING about whether these messages are correct.
    const declared = Object.fromEntries(
      Object.entries(DIRECT_TRANSPORT_SITES).map(([file, sites]) => [file, sites.length]),
    );
    expect(scanDirectTransportSites()).toEqual(declared);
  });

  it('uses only known direct-transport dispositions', () => {
    const allowed = new Set(['mechanism-transport', 'direct-patient', 'direct-supplied']);
    for (const sites of Object.values(DIRECT_TRANSPORT_SITES)) {
      for (const disposition of sites) expect(allowed.has(disposition)).toBe(true);
    }
  });

  it('does not claim the direct-patient sites write a feed row', () => {
    // The honest statement, made checkable. paymentLinkService reaches a
    // patient by WhatsApp and by email and writes no `notifications` row —
    // that is not a defect under this gate's premise (the body is readable),
    // and pretending otherwise by counting it as an emitter would be the
    // "wired but cannot fire" mistake in reverse.
    const directPatient = Object.entries(DIRECT_TRANSPORT_SITES)
      .filter(([, sites]) => sites.includes('direct-patient'))
      .map(([file]) => file);
    expect(directPatient).toEqual(['services/billing/paymentLinkService.js']);
    for (const file of directPatient) {
      expect(EMITTERS[file]).toBeUndefined();
      expect(countFeedRowWrites(readSource(file))).toBe(0);
    }
  });
});

describe('the scanner sees what the census claims it sees', () => {
  // Three cases the reviewer used to walk out of this gate. Each is the
  // mutation itself, held as a permanent case rather than as a one-off
  // experiment, so the hole cannot be reopened by a later "simplification".

  it('sees a schema-qualified or quoted INSERT INTO notifications', () => {
    const pattern = () => insertIntoTable('notifications');
    for (const sql of [
      'INSERT INTO notifications (type) VALUES ($1)',
      'INSERT INTO public.notifications (type) VALUES ($1)',
      'INSERT INTO "notifications" (type) VALUES ($1)',
      'INSERT INTO public."notifications" (type) VALUES ($1)',
      'INSERT INTO "public"."notifications" (type) VALUES ($1)',
      'insert into  PUBLIC . notifications (type) values ($1)',
    ]) {
      expect({ sql, matched: pattern().test(sql) }).toEqual({ sql, matched: true });
    }
  });

  it('does not mistake the neighbouring *_notifications tables for the inbox', () => {
    // All five are real tables this tree inserts into. Matching any of them
    // would make the row-writer set equality fail against phantom writers.
    const pattern = () => insertIntoTable('notifications');
    for (const table of [
      'failed_notifications',
      'scheduled_notifications',
      'stemi_team_notifications',
      'referral_patient_notifications',
      'diagnostic_result_patient_notifications',
      'public.failed_notifications',
    ]) {
      const sql = `INSERT INTO ${table} (type) VALUES ($1)`;
      expect({ sql, matched: pattern().test(sql) }).toEqual({ sql, matched: false });
    }
  });

  it('sees every Prisma write method on the notifications model, not just create', () => {
    for (const method of ['create', 'createMany', 'createManyAndReturn', 'upsert',
      'update', 'updateMany', 'updateManyAndReturn']) {
      const source = `await prisma.notifications.${method}({ data: { type: 'x' } });`;
      expect({ method, writes: ormWriteCalls(source).length }).toEqual({ method, writes: 1 });
    }
    // …and an `update` is a write but NOT a row creation, so it can never
    // discharge a `patient` site's obligation to put a row in the inbox.
    const update = "await prisma.notifications.update({ data: { type: 'x' } });";
    expect(ormRowCreations(update)).toEqual([]);
    expect(countFeedRowWrites(update)).toBe(0);
  });

  it('does not mistake a read, or a local array, for a model write', () => {
    for (const source of [
      'const rows = await prisma.notifications.findMany({ where: { id } });',
      'await prisma.notifications.count();',
      'const flatParams = notifications.flat();',
      'const placeholders = notifications.map((_, index) => index);',
      'await prisma.failed_notifications.create({ data: {} });',
    ]) {
      expect({ source, writes: ormWriteCalls(source).length }).toEqual({ source, writes: 0 });
    }
  });
});

describe('the feed row a patient push points at is reachable', () => {
  // These are the invariants that make a written row actually visible. They
  // are asserted on the shared helper, which every fixed emitter now routes
  // through, so a change there cannot quietly un-fix all of them.
  const helper = readSource('utils/notifications/patientNotificationFeed.js');

  it('binds tenant_id explicitly instead of inheriting the GUC-reading DEFAULT', () => {
    expect(helper).toMatch(/INSERT\s+INTO\s+notifications/i);
    expect(helper).toMatch(/\(tenant_id,\s*uid,\s*user_id,\s*phone/);
    expect(helper).toContain('$8::uuid');
  });

  it('scopes its recipient lookup to the tenant', () => {
    // A bare `WHERE id = $1` on a SERIAL id reads across tenants.
    expect(helper).toMatch(/FROM users[\s\S]*?WHERE tenant_id = \$1::uuid/);
  });

  it('cannot throw into the clinical write that triggered it', () => {
    // Both exported functions are one try/catch whose catch returns a value.
    expect(helper).toMatch(/catch \(err\)[\s\S]*?return false;/);
    expect(helper).not.toMatch(/\bthrow\b/);
  });
});
