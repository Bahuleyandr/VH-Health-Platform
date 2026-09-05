// Cath pre-procedure lab readiness — deep test.
//
// Spec: docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
// Migration 766 (cath_lab_readiness_settings, cath_case_lab_readiness_items,
// lab_results provenance columns).
//
// The fixture is its own tenant so teardown can purge by tenant_id; the case
// starts `scheduled` with the seven other readiness checks already cleared, so
// the `labs` check is the only thing between the case and `ready`.
import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';
import { getCase, updateReadinessCheck } from '../services/clinical/cathLabService.js';
import {
  orderMissingLabs,
  recordExternalLabResult,
  refreshCaseLabReadiness,
  upsertReadinessSettings,
  waiveLabItem,
} from '../services/clinical/cathLabReadinessService.js';
import { clinicalDate } from '../services/clinical/bloodborneMarkerRules.js';
import { recordResultManual } from '../services/lab/labResultsService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000001ab0';
const OTHER_TENANT = '00000000-0000-4000-8000-000000001abf';
const PATIENT = 'cd000000-0000-4000-8000-000000001ab1';
const ACTOR = 'cd000000-0000-4000-8000-000000001aba';
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
  'lab_critical_alerts',
  'lab_pathologist_signoffs',
  'lab_threshold_unmatched_exceptions',
  'lab_results',
  'lab_result_ingest_commands',
  'lab_specimens',
  'investigation_bookings',
  'investigations',
  'tasks',
  'workflow_sla_instances',
  'notifications',
  'clinical_timeline_events',
  'clinical_audit_events',
  'audit_log',
  'audit_logs',
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
            ($1::uuid, $3::uuid, '9011881002', 'Dr Cath Readiness', 'DOCTOR', TRUE, 'active', NOW())`,
    TENANT, PATIENT, ACTOR,
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

const resultIds = [];

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
  resultIds.push(Number(rows[0].id));
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

  afterAll(async () => {
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
    resultIds.push(Number(stored.result.id));
    expect(stored.result.result_origin).toBe('manual_in_house');
    expect(stored.result.external_lab_name).toBeNull();
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
});
