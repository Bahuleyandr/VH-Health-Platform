// Cath pre-procedure lab readiness — deep test.
//
// Spec: docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
// Migration 766 (cath_lab_readiness_settings, cath_case_lab_readiness_items,
// lab_results provenance columns).
//
// The fixture is its own tenant so teardown can purge by tenant_id; the case
// starts `scheduled` with the seven other readiness checks already cleared, so
// the `labs` check is the only thing between the case and `ready`.
import prisma, { ensureTenantRlsRuntimeRoleGrants, setTenantTx } from '../lib/prisma.js';
import {
  createCase,
  getCase,
  listCases,
  updateReadinessCheck,
} from '../services/clinical/cathLabService.js';
import {
  orderMissingLabs,
  recordExternalLabResult,
  refreshCaseLabReadiness,
  unwaiveLabItem,
  upsertReadinessSettings,
  waiveLabItem,
} from '../services/clinical/cathLabReadinessService.js';
import { flushScheduledReadinessRefreshes } from '../services/clinical/cathLabReadinessHooks.js';
import { clinicalDate } from '../services/clinical/bloodborneMarkerRules.js';
import {
  recordExternalLabResultRow,
  recordResultManual,
  signOffResults,
} from '../services/lab/labResultsService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000001ab0';
const OTHER_TENANT = '00000000-0000-4000-8000-000000001abf';
const PATIENT = 'cd000000-0000-4000-8000-000000001ab1';
const ACTOR = 'cd000000-0000-4000-8000-000000001aba';
// signOffResults gates on canSignOffLabResults, which ACTOR's DOCTOR role does
// not satisfy; the end-to-end sign-off test signs as this user.
const PATHOLOGIST = 'cd000000-0000-4000-8000-000000001abd';
const RLS_ROLE = 'vhhealth_runtime';
const READINESS_TYPES = [
  'consent', 'labs', 'allergy_renal_risk', 'anticoagulation',
  'blood_bank', 'equipment', 'implants_device_rep', 'timeout',
];
// Every table this suite writes to, directly or through a service, that carries
// a tenant_id. Purged in FK order under replica mode; the tenant row goes last.
const PURGE_TABLES = [
  'cath_case_lab_readiness_items',
  'cath_lab_readiness_checks',
  'cath_lab_readiness_settings',
  'cath_lab_cases',
  'medication_safety_reviews',
  'patient_bloodborne_markers',
  // A real sign-off (the post-commit-hook test) writes acknowledgement,
  // reconciliation and diagnostic-generation receipts, and an outbox row;
  // several of those tables are append-only, which is why the purge runs
  // under replica mode.
  'lab_critical_alert_acknowledgement_receipts',
  'lab_critical_alert_reconciliation_receipts',
  'lab_critical_alerts',
  'diagnostic_result_generation_items',
  'diagnostic_result_generations',
  'lab_pathologist_signoffs',
  'lab_threshold_unmatched_exceptions',
  'lab_reference_ranges',
  'lab_results',
  'lab_result_ingest_commands',
  'lab_specimens',
  'event_outbox',
  // The inpatient-pathway projector's inbox. A lab write that is linked to an
  // admission publishes a diagnostic-resource-linked event into it, and it is
  // tenant-bearing: without this the suite left rows behind that outlive the
  // tenant row deleted last. Found by sweeping every tenant-bearing table for
  // survivors after a run, not by reading the code — the publisher is three
  // services down from anything this suite calls by name.
  'pathway_projector_inbox',
  'investigation_bookings',
  'investigations',
  'tasks',
  'workflow_sla_instances',
  'notifications',
  'clinical_timeline_events',
  'clinical_audit_events',
  'audit_log',
  'audit_logs',
  // Written by trg_pharmacy_patient_safety_version_753, which fires on every
  // lab_results insert this suite makes. Left behind, its rows outlive the
  // tenant row the teardown deletes last and the next run starts dirty.
  'pharmacy_patient_safety_versions',
  'facilities',
  'users',
];

let CASE_ID;
let FACILITY_ID;
let previousRuntimeRole;
const ctx = (extra = {}) => ({
  actorUid: ACTOR, actorRole: 'DOCTOR', tenantId: TENANT, ...extra,
});

// No calendar literals: a suite pinned to a date starts failing on a date.
const istDaysAgo = (days) => clinicalDate(new Date(Date.now() - days * 86_400_000));

async function purge() {
  await prisma.$transaction(async (tx) => {
    // Teardown runs only on the disposable deep-test database. Disabling user
    // and constraint triggers for this one transaction is what keeps the whole
    // cleanup inside Prisma's 5 s interactive-transaction budget — the same
    // note cath-consumables.deep.test.js carries. Production paths untouched.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    for (const table of PURGE_TABLES) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        TENANT,
        OTHER_TENANT,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
      TENANT,
      OTHER_TENANT,
    );
  });
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, 'clr-readiness-tenant', 'Cath Lab Readiness Tenant'),
            ($2::uuid, 'clr-readiness-other', 'Cath Lab Readiness Other Tenant')`,
    TENANT, OTHER_TENANT,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, status, updated_at)
     VALUES ($1::uuid, $2::uuid, '9011881001', 'Cath Readiness Patient', 'PATIENT', TRUE, 'active', NOW()),
            ($1::uuid, $3::uuid, '9011881002', 'Dr Cath Readiness', 'DOCTOR', TRUE, 'active', NOW()),
            ($1::uuid, $4::uuid, '9011881003', 'Dr Cath Path', 'PATHOLOGIST', TRUE, 'active', NOW())`,
    TENANT, PATIENT, ACTOR, PATHOLOGIST,
  );
  const facilities = await prisma.$queryRawUnsafe(
    `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
     VALUES ($1::uuid, 'CLR-READINESS-A', 'Cath Readiness Facility', 'active', FALSE)
     RETURNING id`,
    TENANT,
  );
  FACILITY_ID = Number(facilities[0].id);
  const cases = await prisma.$queryRawUnsafe(
    `INSERT INTO cath_lab_cases
       (tenant_id, patient_uid, facility_id, requested_procedure, status, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $4::int, 'Elective PTCA', 'scheduled', $3::uuid, $3::uuid)
     RETURNING id`,
    TENANT, PATIENT, ACTOR, FACILITY_ID,
  );
  CASE_ID = Number(cases[0].id);
  // Seven checks cleared, `labs` pending: the lab gate is the only thing left.
  for (const type of READINESS_TYPES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cath_lab_readiness_checks
         (tenant_id, case_id, check_type, status, required, metadata)
       VALUES ($1::uuid, $2::bigint, $3, $4, TRUE, '{}'::jsonb)`,
      TENANT, CASE_ID, type, type === 'labs' ? 'pending' : 'pass',
    );
  }
}

async function seedResult({
  code, value, numeric = null, flag = 'N', critical = false, daysAgo = 1, status = 'final',
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, value_numeric, unit,
        abnormal_flag, is_critical, status, signed_off_at, signed_off_by,
        performed_at, received_at, result_origin)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5::numeric, 'u',
             $6, $7::boolean, $8::text,
             CASE WHEN $8::text = 'final' THEN NOW() ELSE NULL END, $9::uuid,
             NOW() - ($10::int * INTERVAL '1 day'), NOW() - ($10::int * INTERVAL '1 day'), 'analyzer')
     RETURNING id`,
    TENANT, PATIENT, code, value, numeric, flag, critical, status, ACTOR, daysAgo,
  );
  return Number(rows[0].id);
}

const labsCheck = () => prisma.$queryRawUnsafe(
  `SELECT status, metadata FROM cath_lab_readiness_checks
    WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs'`,
  TENANT, CASE_ID,
).then((rows) => rows[0]);

const caseStatus = () => prisma.$queryRawUnsafe(
  `SELECT status FROM cath_lab_cases WHERE tenant_id = $1::uuid AND id = $2::bigint`,
  TENANT, CASE_ID,
).then((rows) => rows[0].status);

const labResultCount = () => prisma.$queryRawUnsafe(
  `SELECT COUNT(*)::int AS n FROM lab_results WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
  TENANT, PATIENT,
).then((rows) => rows[0].n);

// The readiness refresh that a lab write triggers runs post-commit inside the
// write's own call, so the item has normally moved by the time signOffResults
// resolves. Polled anyway, briefly, rather than asserted on the first read:
// the assertion is that the hook fires without anyone asking for a refresh,
// not that it fires within one event-loop turn.
async function pollForItem(itemCode, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT state, lab_result_id FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code = $3`,
      TENANT, CASE_ID, itemCode,
    );
    row = rows[0] || null;
    if (predicate(row) || Date.now() >= deadline) return row;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

d('cath lab readiness (deep)', () => {
  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = RLS_ROLE;
    await ensureTenantRlsRuntimeRoleGrants();
    await purge();
    await seed();
  }, 120000);

  // Lab writes now SCHEDULE their readiness refresh instead of awaiting it, so
  // a test that records a result leaves a job behind. Drain it here: a refresh
  // landing in the middle of the NEXT test's assertions would be a race this
  // suite has no business running.
  afterEach(async () => {
    await flushScheduledReadinessRefreshes();
  }, 120000);

  afterAll(async () => {
    await flushScheduledReadinessRefreshes();
    await purge();
    if (previousRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
  }, 120000);

  test('nothing ordered: seven not_ordered items, check stays pending, six orderable codes', async () => {
    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.items).toHaveLength(7);
    expect(out.items.map((item) => item.state)).toEqual(Array(7).fill('not_ordered'));
    expect(out.items.every((item) => item.required)).toBe(true);
    expect(out.check_status).toBe('pending');
    expect(out.orderable_now).toEqual(['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV']);
    const persisted = await prisma.$queryRawUnsafe(
      `SELECT item_code, state FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint ORDER BY item_code`,
      TENANT, CASE_ID,
    );
    expect(persisted).toHaveLength(7);
  }, 30000);

  test('a settings update may narrow the required set but may never empty it', async () => {
    await expect(upsertReadinessSettings({ tenantId: TENANT, required_items: [] }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_LAB_READINESS_ITEMS_EMPTY' });
    await expect(upsertReadinessSettings({ tenantId: TENANT, required_items: ['hb', 'nonsense'] }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_LAB_READINESS_ITEM_UNKNOWN' });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM cath_lab_readiness_settings WHERE tenant_id = $1::uuid`,
      TENANT,
    );
    expect(rows[0].n).toBe(0);
  });

  test('order-missing places one order per covering code and is idempotent', async () => {
    const first = await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx({ idempotencyKey: 'clr-order-1' }));
    expect(first.created.map((row) => row.code))
      .toEqual(['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV']);
    expect(first.readiness.items.every((item) => item.state === 'ordered_awaiting_sample')).toBe(true);
    const second = await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx({ idempotencyKey: 'clr-order-2' }));
    expect(second.created).toEqual([]);
    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM investigations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status <> 'CANCELLED'`,
      TENANT, PATIENT,
    );
    expect(count[0].n).toBe(6);
  }, 120000);

  test('all results present: auto-pass with a critical warning on potassium; the case turns ready', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE investigations SET status = 'COMPLETED' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, PATIENT,
    );
    await seedResult({ code: 'HGB', value: '12.1', numeric: 12.1 });
    await seedResult({ code: 'PLT', value: '210', numeric: 210 });
    await seedResult({ code: 'CREA', value: '0.9', numeric: 0.9 });
    await seedResult({ code: 'K', value: '6.3', numeric: 6.3, flag: 'HH', critical: true });
    for (const code of ['HIV', 'HBSAG', 'HCV']) {
      await seedResult({ code, value: 'Non-reactive' });
    }
    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.check_status).toBe('pass');
    expect(out.auto_managed).toBe(true);
    expect(out.critical_warning).toBe(true);
    expect(out.critical_items).toEqual(['potassium']);
    expect(out.missing).toEqual([]);
    const row = await labsCheck();
    expect(row.status).toBe('pass');
    expect(row.metadata.auto_managed).toBe(true);
    expect(row.metadata.critical_warning).toBe(true);
    expect(await caseStatus()).toBe('ready');
    const readCase = await getCase(CASE_ID, { tenantId: TENANT });
    expect(readCase.lab_readiness.check_status).toBe('pass');
    expect(readCase.lab_readiness.critical_items).toEqual(['potassium']);
  }, 60000);

  test('a value going stale flips an auto-managed pass back to pending before start, not after', async () => {
    const age = (days) => prisma.$executeRawUnsafe(
      `UPDATE lab_results
          SET performed_at = NOW() - ($3::int * INTERVAL '1 day'),
              received_at = NOW() - ($3::int * INTERVAL '1 day')
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`,
      TENANT, PATIENT, days,
    );
    await age(45);
    const stale = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(stale.check_status).toBe('pending');
    expect((await labsCheck()).metadata.auto_pending_reason).toBe('hb stale');
    await age(1);
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() })).check_status)
      .toBe('pass');
    // Once the patient is on the table, automation stops moving the gate: the
    // team already acted on it.
    await prisma.$executeRawUnsafe(
      `UPDATE cath_lab_cases SET actual_start_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, CASE_ID,
    );
    await age(45);
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() })).check_status)
      .toBe('pass');
    await prisma.$executeRawUnsafe(
      `UPDATE cath_lab_cases SET actual_start_at = NULL WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, CASE_ID,
    );
  }, 60000);

  test('a human pass is never touched by automation, and a human pass over a critical warning writes a safety review', async () => {
    // HGB is still stale from the previous test, so automation wants pending.
    const auto = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(auto.check_status).toBe('pending');
    // The override reason is demanded at the door. Without it the pass is
    // refused, and the refusal leaves the check exactly as it stood — the
    // guard throws inside the transaction, before the upsert.
    const reviewsBefore = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND review_type = 'cath_lab_readiness'`,
      TENANT,
    );
    await expect(updateReadinessCheck(
      CASE_ID,
      { tenantId: TENANT, check_type: 'labs', status: 'pass', notes: '   ' },
      ctx(),
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'CATH_LAB_READINESS_REASON_REQUIRED',
    });
    expect((await labsCheck()).status).toBe('pending');
    const reviewsAfterRefusal = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND review_type = 'cath_lab_readiness'`,
      TENANT,
    );
    expect(reviewsAfterRefusal[0].n).toBe(reviewsBefore[0].n);

    await updateReadinessCheck(
      CASE_ID,
      { tenantId: TENANT, check_type: 'labs', status: 'pass', notes: 'K reviewed by cardiologist' },
      ctx(),
    );
    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.check_status).toBe('pass');
    expect(out.auto_managed).toBe(false);
    const reviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, finding_code, status, override_reason
         FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND review_type = 'cath_lab_readiness'
        ORDER BY id DESC LIMIT 1`,
      TENANT,
    );
    expect(reviews[0]).toMatchObject({
      review_type: 'cath_lab_readiness',
      finding_code: 'CRITICAL_LAB_ACKNOWLEDGED',
      override_reason: 'K reviewed by cardiologist',
    });
    await updateReadinessCheck(
      CASE_ID, { tenantId: TENANT, check_type: 'labs', status: 'pending' }, ctx(),
    );
  }, 60000);

  test('an outside HBsAg result is stored as an external lab row, creates a marker, and counts only when the policy allows', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results
          SET performed_at = NOW() - INTERVAL '1 day', received_at = NOW() - INTERVAL '1 day'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`,
      TENANT, PATIENT,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HBSAG'`,
      TENANT, PATIENT,
    );
    const out = await recordExternalLabResult(CASE_ID, 'hbsag', {
      tenantId: TENANT,
      value_text: 'Non-reactive',
      observed_on: istDaysAgo(5),
      external_lab_name: 'City Path Lab',
      external_report_ref: 'CPL-7781',
    }, ctx({ idempotencyKey: 'clr-ext-1' }));
    const row = await prisma.$queryRawUnsafe(
      `SELECT result_origin, status, signed_off_at, external_lab_name, external_report_ref,
              performed_by_lab, investigation_id, booking_id
         FROM lab_results WHERE id = $1::int`,
      out.lab_result_id,
    );
    expect(row[0]).toMatchObject({
      result_origin: 'external_lab',
      status: 'preliminary',
      signed_off_at: null,
      external_lab_name: 'City Path Lab',
      external_report_ref: 'CPL-7781',
      performed_by_lab: 'City Path Lab',
      investigation_id: null,
      booking_id: null,
    });
    const marker = await prisma.$queryRawUnsafe(
      `SELECT marker, result, source FROM patient_bloodborne_markers
        WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`,
      TENANT, out.lab_result_id,
    );
    expect(marker[0]).toMatchObject({ marker: 'hbsag', result: 'non_reactive', source: 'external_report' });
    expect(out.readiness.items.find((item) => item.item_code === 'hbsag').state).toBe('external_recorded');
    expect(out.readiness.check_status).toBe('pass');

    await upsertReadinessSettings({ tenantId: TENANT, external_results_count: false }, ctx());
    const strict = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(strict.missing).toEqual([{ item: 'hbsag', state: 'external_recorded' }]);
    expect(strict.check_status).toBe('pending');
    await upsertReadinessSettings({ tenantId: TENANT, external_results_count: true }, ctx());
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() })).check_status)
      .toBe('pass');
  }, 60000);

  test('an outside result with no laboratory name is refused before anything is written', async () => {
    const before = await labResultCount();
    await expect(recordExternalLabResult(CASE_ID, 'hiv', {
      tenantId: TENANT,
      value_text: 'Non-reactive',
      observed_on: istDaysAgo(2),
      external_lab_name: '   ',
    }, ctx())).rejects.toMatchObject({ code: 'CATH_LAB_READINESS_VALUE_INVALID' });
    // Tomorrow in Asia/Kolkata is still the future, whatever UTC thinks.
    await expect(recordExternalLabResult(CASE_ID, 'hiv', {
      tenantId: TENANT,
      value_text: 'Non-reactive',
      observed_on: istDaysAgo(-1),
      external_lab_name: 'City Path Lab',
    }, ctx())).rejects.toMatchObject({ code: 'CATH_LAB_READINESS_VALUE_INVALID' });
    expect(await labResultCount()).toBe(before);
  }, 30000);

  test('the public manual path never stores an external origin; the escape needs full provenance', async () => {
    // The public entry point has no parameter that could ask for one. It used
    // to: `allowUnlinkedExternal: true` on this same function was the escape,
    // and the rule that only the cath checklist passed it lived in a comment.
    // Now the escape is a different function (recordExternalLabResultRow) that
    // no route imports, so the assertion below is about a shape the public
    // signature CANNOT express, not about a flag a caller declined to set.
    const inv = await prisma.$queryRawUnsafe(
      `UPDATE investigations SET status = 'REQUESTED'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'CBC'
        RETURNING id`,
      TENANT, PATIENT,
    );
    const stored = await recordResultManual({
      tenantId: TENANT,
      performed_by: ACTOR,
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        investigation_id: Number(inv[0].id),
        patient_uid: PATIENT,
        test_code: 'NA',
        test_name: 'Sodium',
        value_text: '138',
        result_origin: 'external_lab',
        external_lab_name: 'Sneaky',
      },
      idempotencyKey: 'clr-public-1',
      requestBodySha256: 'a'.repeat(64),
    });
    expect(stored.result.result_origin).toBe('manual_in_house');
    expect(stored.result.external_lab_name).toBeNull();
    // A caller that still tries to set the retired flag gets an in-house row,
    // not an external one: the option no longer exists, so it is an unknown key
    // on the argument object and the manual path's forcing applies as always.
    // (It also has no order link, which is what the public path refuses.)
    await expect(recordResultManual({
      tenantId: TENANT,
      performed_by: ACTOR,
      performed_by_role: 'DOCTOR',
      result: {
        patient_uid: PATIENT, test_code: 'K', test_name: 'K', value_text: '4.0',
        result_origin: 'external_lab',
      },
      idempotencyKey: 'clr-public-2',
      requestBodySha256: 'b'.repeat(64),
      allowUnlinkedExternal: true,
    })).rejects.toMatchObject({ code: 'LAB_RESULT_ORDER_LINK_REQUIRED' });

    // The internal entry point is the only way to an external origin, and it
    // will not take one without the laboratory's name and report date.
    await expect(recordExternalLabResultRow({
      tenantId: TENANT,
      performed_by: ACTOR,
      performed_by_role: 'DOCTOR',
      result: {
        patient_uid: PATIENT, test_code: 'K', test_name: 'K', value_text: '4.0',
        result_origin: 'external_lab',
      },
    }, {
      idempotencyKey: 'clr-public-3',
      requestBodySha256: 'b'.repeat(64),
    })).rejects.toMatchObject({ code: 'LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED' });
  }, 60000);

  test('waiving an item makes it available and survives refresh', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HCV'`,
      TENANT, PATIENT,
    );
    const missing = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(missing.missing.map((row) => row.item)).toEqual(['hcv']);
    await expect(waiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_LAB_READINESS_VALUE_INVALID' });
    const waived = await waiveLabItem(
      CASE_ID, 'hcv',
      { tenantId: TENANT, reason: 'Repeat HCV from last month on file elsewhere' },
      ctx(),
    );
    const item = waived.items.find((row) => row.item_code === 'hcv');
    expect(item.state).toBe('waived');
    expect(waived.check_status).toBe('pass');
    const persisted = await prisma.$queryRawUnsafe(
      `SELECT state, waived_by, waive_reason FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code = 'hcv'`,
      TENANT, CASE_ID,
    );
    expect(persisted[0]).toMatchObject({
      state: 'waived',
      waived_by: ACTOR,
      waive_reason: 'Repeat HCV from last month on file elsewhere',
    });
  }, 60000);

  test('the readiness snapshot is invisible to another tenant under the runtime role', async () => {
    const own = await asRlsRole(
      TENANT,
      `SELECT item_code FROM cath_case_lab_readiness_items WHERE case_id = $1::bigint`,
      CASE_ID,
    );
    expect(own).toHaveLength(7);
    const foreign = await asRlsRole(
      OTHER_TENANT,
      `SELECT item_code FROM cath_case_lab_readiness_items WHERE case_id = $1::bigint`,
      CASE_ID,
    );
    expect(foreign).toHaveLength(0);
    const foreignSettings = await asRlsRole(
      OTHER_TENANT,
      `SELECT tenant_id FROM cath_lab_readiness_settings`,
    );
    expect(foreignSettings).toHaveLength(0);
  }, 30000);

  test('freshness follows the outside report date, and an in-flight repeat order stays on an answered item', async () => {
    // (a) The HBsAg row on file is the external one. Move its data-entry clock
    // to now and its REPORT date 200 days back. Freshness must follow the
    // report — the patient's serology is 200 days old however recently a clerk
    // typed it in — so the item goes stale and the gate drops back to pending.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results
          SET performed_at = NOW(), received_at = NOW(),
              external_reported_on = (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 200
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND result_origin = 'external_lab'`,
      TENANT, PATIENT,
    );
    const stale = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(stale.items.find((item) => item.item_code === 'hbsag'))
      .toMatchObject({ state: 'stale', source: 'external' });
    expect(stale.check_status).toBe('pending');

    // (b) A repeat electrolytes draw goes back in flight while the potassium
    // result already on file is still fresh. The result keeps the state; the
    // order only adds its pointers, so nobody is told to order it again.
    //
    // It also pins the zone investigations.requested_at is read in. That column
    // is TIMESTAMP WITHOUT TIME ZONE, so its stored value means nothing until
    // you say who wrote it; every app writer is a UTC-pinned Prisma session
    // (pinSessionTimeZoneToUrl in src/lib/prisma.js), so the naive value is a
    // UTC wall clock and the refresh reads it back with `AT TIME ZONE 'UTC'`.
    // Reading it as IST instead would not fail loudly — it would silently
    // backdate every open order by 5h30m — so the drift is asserted below
    // rather than left to a state that happens to survive either reading.
    // The database's own NOW(), un-backdated. It used to be NOW() - INTERVAL
    // '1 minute': the resolver took `asOf = new Date()` off the node clock,
    // which runs a millisecond or two behind the database's, so an order
    // stamped with the database's NOW() read as FUTURE-dated against
    // `withinWindow`'s `age >= 0` bound and was dropped — about one run in
    // three. The fix was to take asOf from the DATABASE (clock_timestamp() on
    // the refresh's own transaction), so the two instants are now readings of
    // ONE clock and an order placed a moment ago is simply in the past. The
    // backdate was compensating for the defect and is gone with it; leaving it
    // would have hidden a relapse.
    const repeat = await prisma.$queryRawUnsafe(
      `UPDATE investigations
          SET status = 'REQUESTED', requested_at = NOW()
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND test_code = 'ELECTROLYTES'
        RETURNING id`,
      TENANT, PATIENT,
    );
    const after = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    const potassium = after.items.find((item) => item.item_code === 'potassium');
    expect(potassium).toMatchObject({
      state: 'result_final',
      is_critical: true,
      investigation_id: Number(repeat[0].id),
    });
    expect(typeof potassium.ordered_at).toBe('string');
    expect(after.orderable_now).not.toContain('ELECTROLYTES');
    const persisted = await prisma.$queryRawUnsafe(
      `SELECT state, investigation_id, observed_at, ordered_at
         FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code = 'potassium'`,
      TENANT, CASE_ID,
    );
    expect(persisted[0]).toMatchObject({
      state: 'result_final',
      investigation_id: Number(repeat[0].id),
    });
    expect(persisted[0].ordered_at).not.toBeNull();
    expect(persisted[0].observed_at).not.toBeNull();
    // The persisted TIMESTAMPTZ must be the naive requested_at read as UTC, to
    // within the millisecond the epoch twin rounds to. A different zone in the
    // refresh query shows up here as a 19800-second drift.
    const drift = await prisma.$queryRawUnsafe(
      `SELECT ABS(EXTRACT(EPOCH FROM (item.ordered_at - (inv.requested_at AT TIME ZONE 'UTC'))))::float8
                AS seconds
         FROM cath_case_lab_readiness_items item
         JOIN investigations inv
           ON inv.id = item.investigation_id
          AND inv.tenant_id = item.tenant_id
        WHERE item.tenant_id = $1::uuid
          AND item.case_id = $2::bigint
          AND item.item_code = 'potassium'`,
      TENANT, CASE_ID,
    );
    expect(drift[0].seconds).toBeLessThan(1);
  }, 60000);

  // ---- review fixes: consistency, ownership, bookings, write-once ----------

  test('an outside quantitative result stores the number and its unit, as a preliminary external row', async () => {
    // The creatinine on file is the analyzer's; retire it so the outside value
    // is the latest and the item resolves from it.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'CREA'`,
      TENANT, PATIENT,
    );
    const out = await recordExternalLabResult(CASE_ID, 'creatinine', {
      tenantId: TENANT,
      value_numeric: 1.2,
      observed_on: istDaysAgo(1),
      external_lab_name: 'City Path Lab',
      external_report_ref: 'CPL-9001',
    }, ctx({ idempotencyKey: 'clr-ext-crea-1' }));

    expect(out.readiness.items.find((row) => row.item_code === 'creatinine')).toMatchObject({
      state: 'external_recorded', value_numeric: 1.2, unit: 'mg/dL', source: 'external',
    });
    const row = await prisma.$queryRawUnsafe(
      `SELECT value_text, value_numeric, unit, abnormal_flag, result_origin
         FROM lab_results WHERE id = $1::int`,
      out.lab_result_id,
    );
    expect(row[0]).toMatchObject({
      value_text: '1.2', unit: 'mg/dL', result_origin: 'external_lab', abnormal_flag: null,
    });
    expect(Number(row[0].value_numeric)).toBe(1.2);
  }, 60000);

  test('an outside value is scored by the SAME governed threshold rail an in-house one is', async () => {
    // Spec §8.2 asks that an outside numeric value carry the abnormal_flag an
    // in-house one would. On this platform that is not a lookup the writer
    // performs: lab_results.abnormal_flag (with reference_range and its two
    // bounds) is rewritten from the governed threshold assessment right after
    // the insert, for every writer — the panel path inserts abnormal_flag: null
    // outright and lets the rail decide. So "the same flag" means "the same
    // rail", and what this pins is that the outside row went through it and
    // carries its verdict, rather than a second flag invented on the way in.
    //
    // A lab_reference_ranges row is seeded precisely to prove it is NOT the
    // authority here: giving an outside creatinine an H that the in-house one
    // for the same analyte would not carry is the inconsistency §8.2 exists to
    // prevent.
    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_reference_ranges
         (tenant_id, test_code, test_name, unit, range_low, range_high, critical_high, is_active)
       VALUES ($1::uuid, 'CREA', 'Serum Creatinine', 'mg/dL', 0.6, 1.3, 4.0, TRUE)`,
      TENANT,
    );
    const out = await recordExternalLabResult(CASE_ID, 'creatinine', {
      tenantId: TENANT,
      value_numeric: 2.4,
      observed_on: istDaysAgo(0),
      external_lab_name: 'City Path Lab',
      external_report_ref: 'CPL-9002',
    }, ctx({ idempotencyKey: 'clr-ext-crea-2' }));

    const row = await prisma.$queryRawUnsafe(
      `SELECT abnormal_flag, criticality_status, threshold_evaluated_at, is_critical
         FROM lab_results WHERE id = $1::int`,
      out.lab_result_id,
    );
    // The rail ran (it stamped its verdict and the time it reached it) and, this
    // tenant having no governed policy for CREA, it owns the flag as null.
    expect(row[0].criticality_status).toBe('threshold_unavailable');
    expect(row[0].threshold_evaluated_at).not.toBeNull();
    expect(row[0].abnormal_flag).toBeNull();
    expect(row[0].is_critical).toBe(false);
    // ...and the checklist item reports exactly what the row says, never a
    // second opinion computed beside it.
    expect(out.readiness.items.find((row2) => row2.item_code === 'creatinine'))
      .toMatchObject({ abnormal_flag: null, is_critical: false, value_numeric: 2.4 });
  }, 60000);

  test('createCase returns a lab-readiness block: the refresh runs on the transaction that inserted the case', async () => {
    const created = await createCase({
      tenantId: TENANT,
      patient_uid: PATIENT,
      facility_id: FACILITY_ID,
      requested_procedure: 'Diagnostic CAG',
    }, ctx());
    // It used to be null every time: the refresh opened its own transaction and
    // could not see the case the caller's transaction had not committed yet.
    expect(created.lab_readiness).not.toBeNull();
    expect(Number(created.lab_readiness.case_id)).toBe(Number(created.id));
    expect(created.lab_readiness.items).toHaveLength(7);
  }, 60000);

  test('the read that flips the check reports ONE answer: readiness, lab_readiness and the gate agree', async () => {
    // Bring the outside HBsAg back inside its window (the previous test pushed
    // its report date 200 days back) so every required item is available again.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results
          SET external_reported_on = (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 2
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND test_code = 'HBSAG'
          AND result_origin = 'external_lab'`,
      TENANT, PATIENT,
    );
    // Hand the check back to automation so THIS read is the one that flips it.
    await prisma.$executeRawUnsafe(
      `UPDATE cath_lab_readiness_checks
          SET status = 'pending', completed_by = NULL, completed_at = NULL,
              metadata = '{}'::jsonb
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs'`,
      TENANT, CASE_ID,
    );

    const readCase = await getCase(CASE_ID, { tenantId: TENANT });

    const labs = readCase.readiness.find((row) => row.check_type === 'labs');
    expect(readCase.lab_readiness.check_status).toBe('pass');
    // The three used to disagree on the read that flipped the check: the check
    // rows and the gate were read BEFORE the refresh, so one response carried
    // "labs pending, gate not ready, lab_readiness pass".
    expect(labs.status).toBe(readCase.lab_readiness.check_status);
    expect(readCase.readiness_gate.ready).toBe(true);
    expect(readCase.readiness_gate.blocking).toEqual([]);
    expect(await caseStatus()).toBe('ready');
  }, 60000);

  test('a human pass keeps its own evidence: a later refresh rewrites neither the owner nor the attachment', async () => {
    const evidence = () => prisma.$queryRawUnsafe(
      `SELECT status, evidence_owner, source_name, attachment_ref, completed_by
         FROM cath_lab_readiness_checks
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs'`,
      TENANT, CASE_ID,
    ).then((rows) => rows[0]);

    await updateReadinessCheck(CASE_ID, {
      tenantId: TENANT,
      check_type: 'labs',
      status: 'pass',
      evidence_owner: 'Dr Cath Readiness',
      source_name: 'consultant review',
      attachment_ref: 'note:cardiology-review',
      notes: 'Critical potassium reviewed at the bedside',
    }, ctx());

    const before = await evidence();
    expect(before).toMatchObject({
      status: 'pass',
      evidence_owner: 'Dr Cath Readiness',
      source_name: 'consultant review',
      attachment_ref: 'note:cardiology-review',
      completed_by: ACTOR,
    });

    await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });

    // Automation owns those three columns only on a row it is moving, or one it
    // already owns. It used to stamp them on every refresh, so the next case
    // read erased the person who cleared the check and the note they attached.
    expect(await evidence()).toEqual(before);
  }, 60000);

  test('a refresh that changes nothing rewrites nothing; a changed result still rewrites its item', async () => {
    const stamps = () => prisma.$queryRawUnsafe(
      `SELECT item_code, refreshed_at FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint
        ORDER BY item_code`,
      TENANT, CASE_ID,
    ).then((rows) => rows.map((row) => `${row.item_code}:${row.refreshed_at.toISOString()}`));

    // The hcv row waived earlier in this suite is still waived, and it is the
    // only row whose waived_at reaches the UPSERT from a driver-materialised
    // Date rather than from an ISO string the resolver built. Asserting it is
    // here makes the no-op claim below a pin on that conversion too: bind the
    // instant in a shape that does not compare equal to what Postgres stored,
    // and this row rewrites itself on every read of the case.
    const waived = await prisma.$queryRawUnsafe(
      `SELECT item_code, waived_at FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND state = 'waived'`,
      TENANT, CASE_ID,
    );
    expect(waived.map((row) => row.item_code)).toEqual(['hcv']);
    expect(waived[0].waived_at).toBeInstanceOf(Date);

    await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    const before = await stamps();
    await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    // Every GET of the case runs a refresh. Seven UPSERTs per read, for rows
    // that say exactly what they already said, is the whole reason this holds.
    expect(await stamps()).toEqual(before);

    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET value_text = '11.4', value_numeric = 11.4
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`,
      TENANT, PATIENT,
    );
    await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    const after = await stamps();
    const moved = after.filter((row, index) => row !== before[index]);
    expect(moved).toHaveLength(1);
    expect(moved[0].startsWith('hb:')).toBe(true);
  }, 60000);

  test('a booking with no investigations row is an open order: the item reads ordered and no duplicate is placed', async () => {
    // Retire every haemoglobin value and every CBC order, so the ONLY evidence
    // that a count has been asked for is the patient-app booking.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`,
      TENANT, PATIENT,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE investigations SET status = 'CANCELLED'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'CBC'`,
      TENANT, PATIENT,
    );
    const cbcCount = () => prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM investigations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND test_code = 'CBC' AND status <> 'CANCELLED'`,
      TENANT, PATIENT,
    ).then((rows) => rows[0].n);
    expect(await cbcCount()).toBe(0);

    const catalogue = await prisma.$queryRawUnsafe(
      `SELECT id FROM investigation_test_catalog WHERE code = 'CBC' LIMIT 1`,
    );
    const patient = await prisma.$queryRawUnsafe(
      `SELECT id, phone FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT, PATIENT,
    );
    // created_at is the database's NOW(), un-backdated — the same instant the
    // column default would have written. It used to be NOW() - INTERVAL
    // '1 minute' for the same reason the repeat order above was backdated: the
    // resolver's `asOf` came off the node clock, so a booking stamped by the
    // database read as future-dated and `withinWindow`'s `age >= 0` bound
    // dropped it. asOf is the database's clock_timestamp() now, so there is one
    // clock and nothing to compensate for.
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigation_bookings
         (tenant_id, patient_id, patient_name, patient_phone, selected_tests,
          status, investigation_id, created_at)
       VALUES ($1::uuid, $2::int, 'Cath Readiness Patient', $3, ARRAY[$4::int],
               'BOOKED', NULL, NOW())`,
      TENANT, Number(patient[0].id), patient[0].phone, Number(catalogue[0].id),
    );

    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.items.find((item) => item.item_code === 'hb')).toMatchObject({
      state: 'ordered_awaiting_sample',
      // A booking carries no investigations row to point at, and 0 is not an id.
      investigation_id: null,
    });
    expect(out.open_order_codes).toContain('CBC');
    expect(out.orderable_now).not.toContain('CBC');

    const placed = await orderMissingLabs(
      CASE_ID, { tenantId: TENANT }, ctx({ idempotencyKey: 'clr-order-booking' }),
    );
    expect(placed.created.map((row) => row.code)).not.toContain('CBC');
    expect(await cbcCount()).toBe(0);
  }, 120000);

  test('the real sign-off path moves the item to result_final through its post-commit hook, with no refresh call here', async () => {
    // signOffResults needs the state BEFORE sign-off — a preliminary row linked
    // to an investigation order, because deriveSignoffEpisode rejects a result
    // with no order episode. Same fixture recipe as bloodborne-markers.deep.
    const patient = await prisma.$queryRawUnsafe(
      `SELECT id, phone FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT, PATIENT,
    );
    const orders = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, phone, patient_id, patient_uid, test_name, test_type,
          status, priority, requested_by, requested_at, updated_at)
       VALUES ($1::uuid, $2, $3::int, $4::uuid, 'HGB', 'blood', 'IN_PROGRESS',
               'NORMAL', $5::uuid, NOW(), NOW())
       RETURNING id`,
      TENANT, patient[0].phone, Number(patient[0].id), PATIENT, ACTOR,
    );
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, investigation_id, test_code, test_name,
          value_text, value_numeric, unit, status, performed_at, received_at)
       VALUES ($1::uuid, $2::uuid, $3::int, 'HGB', 'HGB', '13.1', 13.1, 'g/dL',
               'preliminary', NOW(), NOW())
       RETURNING id`,
      TENANT, PATIENT, Number(orders[0].id),
    );
    const resultId = Number(rows[0].id);

    // The refresh is SCHEDULED off the sign-off's critical path, not awaited on
    // it — and the proof has to be a barrier, not a stopwatch. refreshCase-
    // LabReadiness locks the case row (FOR NO KEY UPDATE), so a conflicting FOR
    // UPDATE held across the sign-off pins the scheduled job at its first
    // statement: while this lock is held the item CANNOT move. signOffResults
    // returning anyway is the assertion. Put the refresh back on the critical
    // path and signOffResults blocks on this same lock instead — the safety
    // release below turns that into a failed assertion rather than a hung suite.
    let releaseCaseLock;
    const caseLockReleased = new Promise((resolve) => { releaseCaseLock = resolve; });
    let caseLockTaken;
    const caseLocked = new Promise((resolve) => { caseLockTaken = resolve; });
    const caseLockHolder = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM cath_lab_cases
          WHERE tenant_id = $1::uuid AND id = $2::bigint FOR UPDATE`,
        TENANT, CASE_ID,
      );
      caseLockTaken();
      await caseLockReleased;
    }, { timeout: 30000 });
    await caseLocked;
    const safetyRelease = setTimeout(() => releaseCaseLock(), 3000);

    await signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'verified',
      patient_uid: PATIENT,
    });

    // Returned while the refresh is still pinned behind the row lock: the
    // sign-off did not wait for it.
    const atReturn = await pollForItem('hb', () => true);
    expect(atReturn?.state).not.toBe('result_final');

    clearTimeout(safetyRelease);
    releaseCaseLock();
    await caseLockHolder;

    // Deliberately NO refresh call: the only thing that can move the item is
    // refreshOpenCasesForPatient, fired post-commit from inside the sign-off
    // through the scheduler. flush() awaits exactly that job.
    await flushScheduledReadinessRefreshes();
    const item = await pollForItem('hb', (row) => row?.state === 'result_final');
    expect(item).toMatchObject({ state: 'result_final', lab_result_id: resultId });
  }, 120000);
  test('a waiver recorded after the procedure started is accepted and marked recorded_after_start', async () => {
    // A fresh, signed HCV value, so the item has real evidence to fall back to
    // when the waiver over it is lifted two tests below. Every earlier HCV row
    // (in-house and outside) is cancelled first so the resolver has one answer.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HCV'`,
      TENANT, PATIENT,
    );
    await seedResult({ code: 'HCV', value: 'Non-reactive' });
    const waived = await waiveLabItem(
      CASE_ID, 'hcv',
      { tenantId: TENANT, reason: 'Outside HCV report sighted at the desk' },
      ctx(),
    );
    expect(waived.items.find((row) => row.item_code === 'hcv')).toMatchObject({
      state: 'waived',
      // Recorded before the patient was on the table: an ordinary
      // pre-procedure waiver, and it must not be marked late.
      recorded_after_start: false,
    });

    // The two instants this test is about are ORDERED by the fixture rather
    // than by how fast the suite runs: the hcv waiver is moved an hour back and
    // the start a minute back, so hcv was waived before the case began and the
    // hiv waiver below is written after it. The comparison is at millisecond
    // resolution, and three writes a few microseconds apart share one
    // millisecond.
    await prisma.$executeRawUnsafe(
      `UPDATE cath_case_lab_readiness_items SET waived_at = NOW() - INTERVAL '1 hour'
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code = 'hcv'`,
      TENANT, CASE_ID,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE cath_lab_cases SET actual_start_at = NOW() - INTERVAL '1 minute'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, CASE_ID,
    );
    try {
      // OWNER DECISION, 2026-09-06 (confirmed to the merge authority):
      // record-yes. "In emergencies with no reports immediately available we
      // will proceed with no reports and we might add while the procedure is
      // ongoing and the reports become available; we do not want the pre-cath
      // checklist to be restrictive as principle."
      //
      // So the waiver is ACCEPTED once the case is running. Refusing it would
      // not stop the team proceeding without HIV — it would only stop them
      // writing down that they did. The other direction is the NEXT test: a
      // lift after the start is refused, and the pair of them is the whole of
      // the asymmetry.
      const lateWaive = await waiveLabItem(
        CASE_ID, 'hiv',
        { tenantId: TENANT, reason: 'Primary PCI under way, no HIV report available' },
        ctx(),
      );
      expect(lateWaive.items.find((row) => row.item_code === 'hiv')).toMatchObject({
        state: 'waived',
        // Marked, not refused: the record shows it was documented late.
        recorded_after_start: true,
      });
      // The waiver that predates the start is untouched by the same read.
      expect(lateWaive.items.find((row) => row.item_code === 'hcv')).toMatchObject({
        state: 'waived', recorded_after_start: false,
      });
      const waiveAudit = await prisma.$queryRawUnsafe(
        `SELECT metadata FROM audit_logs
          WHERE tenant_id = $1::uuid AND action = 'cath_lab.readiness.labs.item_waived'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        TENANT,
      );
      expect(waiveAudit[0].metadata).toMatchObject({
        item: 'hiv', recorded_after_start: true,
      });

      // The write really landed on the stored row, and hcv's own waiver — the
      // one a later test lifts — is still exactly as it was.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT item_code, state, waive_reason FROM cath_case_lab_readiness_items
          WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code IN ('hiv', 'hcv')
          ORDER BY item_code`,
        TENANT, CASE_ID,
      );
      expect(rows.find((row) => row.item_code === 'hiv')).toMatchObject({
        state: 'waived',
        waive_reason: 'Primary PCI under way, no HIV report available',
      });
      expect(rows.find((row) => row.item_code === 'hcv')).toMatchObject({
        state: 'waived',
        waive_reason: 'Outside HCV report sighted at the desk',
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE cath_lab_cases SET actual_start_at = NULL WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT, CASE_ID,
      );
    }
  }, 60000);

  test('a waiver may not be lifted once the procedure has started', async () => {
    // The other half of the owner's decision (2026-09-06): record-yes,
    // LIFT-NO. Set up rather than inherited, so this test runs on its own as
    // well as after the one above — waiveLabItem is an upsert, so re-waiving
    // the item the previous test already waived is the same one row either way.
    const waived = await waiveLabItem(
      CASE_ID, 'hiv',
      { tenantId: TENANT, reason: 'Primary PCI under way, no HIV report available' },
      ctx(),
    );
    expect(waived.items.find((row) => row.item_code === 'hiv').state).toBe('waived');

    const unwaiveAudits = async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1::uuid AND action = 'cath_lab.readiness.labs.unwaived'`,
        TENANT,
      );
      return rows[0].n;
    };
    const auditsBefore = await unwaiveAudits();

    await prisma.$executeRawUnsafe(
      `UPDATE cath_lab_cases SET actual_start_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, CASE_ID,
    );
    try {
      // A lift re-resolves the item from evidence — here there is none, so hiv
      // would go back to missing and the labs check back to pending. But
      // recomputeCaseStatusTx only rewrites a case whose status is scheduled /
      // readiness_pending / ready, so a RUNNING case's status would not move
      // and the board would show nothing. The regression would be invisible,
      // which is why a mis-tap with the patient on the table is refused
      // outright rather than marked the way a late RECORD is.
      await expect(unwaiveLabItem(
        CASE_ID, 'hiv', { tenantId: TENANT, reason: 'HIV report reached the lab' }, ctx(),
      )).rejects.toMatchObject({
        statusCode: 409, code: 'CATH_LAB_READINESS_CASE_STARTED',
      });

      // The refusal wrote NOTHING: the waiver stands, with its own reason...
      const rows = await prisma.$queryRawUnsafe(
        `SELECT state, waive_reason, waived_by FROM cath_case_lab_readiness_items
          WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code = 'hiv'`,
        TENANT, CASE_ID,
      );
      expect(rows[0]).toMatchObject({
        state: 'waived',
        waive_reason: 'Primary PCI under way, no HIV report available',
      });
      expect(rows[0].waived_by).not.toBeNull();
      // ...and no 'unwaived' row joined the trail claiming otherwise.
      expect(await unwaiveAudits()).toBe(auditsBefore);
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE cath_lab_cases SET actual_start_at = NULL WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT, CASE_ID,
      );
    }
  }, 60000);

  test('lifting a waiver resolves the item from evidence again, and refuses a second lift', async () => {
    const before = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(before.items.find((row) => row.item_code === 'hcv').state).toBe('waived');

    const after = await unwaiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'The in-house HCV came back' }, ctx(),
    );

    // Not 'not_ordered' and not still 'waived': the refresh that ran on the
    // same transaction re-resolved the item from the patient's own row, which
    // is the whole contract of this action.
    const item = after.items.find((row) => row.item_code === 'hcv');
    expect(item).toMatchObject({
      state: 'result_final',
      source: 'lab_result',
      waived_by: null,
      waived_at: null,
      waive_reason: null,
    });
    const persisted = await prisma.$queryRawUnsafe(
      `SELECT state, source, waived_by, waived_at, waive_reason
         FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND item_code = 'hcv'`,
      TENANT, CASE_ID,
    );
    expect(persisted[0]).toMatchObject({
      state: 'result_final', source: 'lab_result', waived_by: null, waived_at: null, waive_reason: null,
    });

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata FROM audit_logs
        WHERE tenant_id = $1::uuid AND action = 'cath_lab.readiness.labs.unwaived'
        ORDER BY created_at DESC LIMIT 1`,
      TENANT,
    );
    expect(audit[0].metadata).toMatchObject({
      item: 'hcv',
      reason: 'The in-house HCV came back',
      // The withdrawn waiver's OWN reason: a log saying an override was lifted
      // without saying which override is not a trail.
      previous_reason: 'Outside HCV report sighted at the desk',
    });

    // A second tap is told the waiver is already gone rather than writing a
    // second 'unwaived' row about a waiver that was not there.
    await expect(unwaiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT }, ctx()))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATH_LAB_READINESS_NOT_WAIVED' });
  }, 60000);

  test('lifting a waiver over an item with NO evidence puts the case back off ready', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET status = 'cancelled'
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HCV'`,
      TENANT, PATIENT,
    );
    const waived = await waiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'Proceeding without HCV' }, ctx(),
    );
    expect(waived.missing.map((row) => row.item)).not.toContain('hcv');
    // Hand the check back to automation before the lift. Earlier tests in this
    // file leave a HUMAN pass on the row, and automation never retracts one —
    // so without this the assertion below would be about who owns the check,
    // not about what lifting a waiver does.
    await updateReadinessCheck(
      CASE_ID, { tenantId: TENANT, check_type: 'labs', status: 'pending' }, ctx(),
    );
    const autoPassed = await refreshCaseLabReadiness({
      tenantId: TENANT, caseId: CASE_ID, context: ctx(),
    });
    expect(autoPassed).toMatchObject({ check_status: 'pass', auto_managed: true });

    const after = await unwaiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT }, ctx());

    expect(after.items.find((row) => row.item_code === 'hcv').state).toBe('not_ordered');
    expect(after.missing.map((row) => row.item)).toContain('hcv');
    expect(after.check_status).toBe('pending');
    expect(await caseStatus()).toBe('readiness_pending');
  }, 60000);
  test('the case list carries the STORED readiness summary, and refreshes nothing', async () => {
    // A second case in the same tenant, inserted RAW so nothing has ever
    // resolved its readiness: it is the "not known" half of this payload.
    const unread = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, facility_id, requested_procedure, status, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $4::int, 'Unread PTCA', 'scheduled', $3::uuid, $3::uuid)
       RETURNING id`,
      TENANT, PATIENT, ACTOR, FACILITY_ID,
    );
    const unreadId = Number(unread[0].id);

    const known = await refreshCaseLabReadiness({
      tenantId: TENANT, caseId: CASE_ID, context: ctx(),
    });
    const cases = await listCases({ tenantId: TENANT, limit: 500 });

    const summary = cases.find((row) => Number(row.id) === CASE_ID).lab_readiness_summary;
    // Exactly these keys. Every one is a status, a flag, a count, an item CODE
    // or a timestamp — there is no value, no abnormal flag and no
    // `critical_items`, which is what lets GET /cases skip the serology
    // projection the per-case surfaces run.
    expect(Object.keys(summary).sort()).toEqual([
      'auto_managed', 'check_status', 'critical_warning',
      'live_evidence_refreshed_at', 'missing_count', 'missing_items',
    ]);
    // ...and it agrees with the refresh that wrote the rows it read.
    expect(summary.check_status).toBe(known.check_status);
    expect(summary.critical_warning).toBe(known.critical_warning);
    expect(summary.missing_items).toEqual(known.missing.map((row) => row.item));
    expect(summary.missing_count).toBe(known.missing.length);
    expect(typeof summary.live_evidence_refreshed_at).toBe('string');

    // A case nobody has opened answers null — NOT an empty summary, which the
    // ward would read as "nothing missing" about a case with no evidence at all.
    const unreadRow = cases.find((row) => Number(row.id) === unreadId);
    expect(unreadRow.lab_readiness_summary).toBeNull();

    // And the list did not RESOLVE it into existence: the read-through refresh
    // is a per-case act, and running it once per card would put a lock and a
    // write cycle on every poll of a screen that is open all day.
    const written = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint`,
      TENANT, unreadId,
    );
    expect(written[0].n).toBe(0);
  }, 60000);

  // ---- the freshness clock is the DATABASE's ------------------------------

  test('the freshness clock is the database clock, read on the refresh transaction', async () => {
    // WHY THIS IS A SPY AND NOT A TOLERANCE. The property is "the instant the
    // refresh evaluated freshness at came from Postgres", and a bracket —
    // clock_timestamp() before, clock_timestamp() after, assert the reported
    // instant sits between — cannot prove it: the node clock sits between those
    // two readings almost every run, so the assertion would pass on the very
    // defect it exists to catch, and fail only on the runs where the skew
    // happened to fall the other way. That is the shape of the flake this lane
    // came from, and it is not a pin.
    //
    // refreshCaseLabReadiness already takes an injected `db` (the caller's
    // transaction client). So this hands it a PASS-THROUGH recorder over a real
    // tenant-scoped transaction: every statement runs unchanged against
    // Postgres, and the clock read is captured on the way back. The assertion
    // is then an EQUALITY against the row the database returned — not a window
    // — plus the count of clock reads, which is what makes it deterministic.
    // Restore `asOf = new Date()` and the refresh asks the database for nothing:
    // clockReads is empty and this is red on every run, not one in three.
    const clockReads = [];
    const out = await setTenantTx(TENANT, async (tx) => {
      const recorder = {
        $queryRawUnsafe: async (sql, ...params) => {
          const rows = await tx.$queryRawUnsafe(sql, ...params);
          if (/clock_timestamp\s*\(/i.test(String(sql))) clockReads.push(rows);
          return rows;
        },
        $executeRawUnsafe: (sql, ...params) => tx.$executeRawUnsafe(sql, ...params),
      };
      // Drop the stamp so the metadata write below is unconditional: the
      // refresh only rewrites the check row when something changed or the
      // stamp has aged past EVIDENCE_STAMP_MAX_AGE_MS, and this test is about
      // the VALUE that gets written, not about when it does.
      await tx.$executeRawUnsafe(
        `UPDATE cath_lab_readiness_checks
            SET metadata = COALESCE(metadata, '{}'::jsonb) - 'live_evidence_refreshed_at'
          WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs'`,
        TENANT, CASE_ID,
      );
      return refreshCaseLabReadiness({
        tenantId: TENANT, caseId: CASE_ID, db: recorder, context: ctx(),
      });
    });

    // Exactly one reading, from Postgres. One because clock_timestamp() is
    // volatile: two calls are two instants, and a refresh that ranked against
    // one and stamped with another would be back to comparing two clocks.
    expect(clockReads).toHaveLength(1);
    const dbMs = Number(clockReads[0][0].as_of_epoch_ms);
    expect(Number.isInteger(dbMs)).toBe(true);
    // EQUALITY, to the millisecond, against the value the database handed back.
    expect(Date.parse(out.evaluated_at)).toBe(dbMs);

    // ...and the stamp the refresh PERSISTED is that same number, so the
    // instant the ward reads off the check row is the instant the decision was
    // actually made on.
    const stored = await prisma.$queryRawUnsafe(
      `SELECT metadata->>'live_evidence_refreshed_at' AS stamp
         FROM cath_lab_readiness_checks
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs'`,
      TENANT, CASE_ID,
    );
    expect(Date.parse(stored[0].stamp)).toBe(dbMs);
  }, 60000);
});
