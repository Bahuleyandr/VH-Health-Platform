import { jest } from '@jest/globals';

const actualPrisma = await import('../lib/prisma.js');
const prisma = actualPrisma.default;
const TENANT = '00000000-0000-4000-8000-00000000c20c';
const ACTOR = '00000000-0000-4000-8000-00000000c20e';
const PATIENTS = ['00000000-0000-4000-8000-00000000c20d', '00000000-0000-4000-8000-00000000c20f'];
const NativeDate = Date;
let zone = 'UTC';
let captures = [];
let rejectAudit = false;

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrisma,
  setTenantTx: (tenantId, fn, options) => actualPrisma.setTenantTx(tenantId, async (tx) => {
    if (tenantId !== TENANT) return fn(tx);
    await tx.$queryRawUnsafe("SELECT set_config('TimeZone', $1, true)", zone);
    const [before] = await tx.$queryRawUnsafe(
      "SELECT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS started_ms, current_user AS role, txid_current()::text AS tx_id, current_setting('TimeZone') AS zone",
    );
    await tx.$executeRawUnsafe('SELECT pg_sleep(0.025)');
    const originalQuery = tx.$queryRawUnsafe;
    const query = originalQuery.bind(tx);
    tx.$queryRawUnsafe = async (sql, ...params) => {
      if (rejectAudit && sql.includes('INSERT INTO clinical_audit_events')) throw new Error('synthetic audit failure');
      const rows = await query(sql, ...params);
      if (sql === 'SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS recorded_at_epoch_ms') {
        expect(rows).toHaveLength(1);
        const [after] = await query("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS observed_ms, txid_current()::text AS tx_id, current_setting('TimeZone') AS zone, pg_backend_pid() AS backend_pid");
        captures.push({ before, after, recordedAt: new NativeDate(Number(rows[0].recorded_at_epoch_ms)) });
      }
      return rows;
    };
    try {
      expect(actualPrisma.isTenantTransactionClient(tx)).toBe(true);
      return await fn(tx);
    } finally {
      tx.$queryRawUnsafe = originalQuery;
    }
  }, options),
}));
jest.unstable_mockModule('../services/emr/dischargeSummaryGenerator.js', () => ({
  generateDischargeSummary: jest.fn(async () => { throw new Error('No external summary provider in clock proof'); }),
  getLatestDischargeSummary: jest.fn(), saveDischargeSummary: jest.fn(),
}));
const admissionService = (await import('../services/emr/admissionService.js')).default;
const { teardownTenantFixture } = await import('./helpers/tenantTeardown.js');
const d = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL ? describe : describe.skip;
let previousEnforcement;
let previousRole;

async function cleanup() {
  await teardownTenantFixture(prisma, {
    tenantIds: [TENANT],
    evidence: async (tx) => {
      for (const table of ['pathway_projector_inbox', 'event_outbox', 'workflow_sla_instances',
        'clinical_timeline_events', 'clinical_audit_events', 'e_prescriptions', 'pharmacy_orders',
        'discharge_consults', 'admissions', 'patient_encounters', 'audit_log', 'audit_logs']) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id=$1::uuid`, TENANT);
      }
    },
  });
}

d('discharge database-clock evidence', () => {
  beforeAll(async () => {
    previousEnforcement = process.env.AUTH_ENFORCE_TENANT_RLS;
    previousRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
    await actualPrisma.ensureTenantRlsRuntimeRoleGrants();
    await cleanup();
    await prisma.$executeRawUnsafe("INSERT INTO tenants(id, slug, name) VALUES ($1::uuid, 'discharge-clock-test', 'Discharge Clock Test')", TENANT);
    for (const [index, uid] of [...PATIENTS, ACTOR].entries()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Clock Fixture', $4, TRUE, 'active', NOW())`,
        TENANT, uid, `90118829${index}1`, uid === ACTOR ? 'DOCTOR' : 'PATIENT',
      );
    }
  }, 120000);

  afterEach(() => { global.Date = NativeDate; });
  afterAll(async () => {
    global.Date = NativeDate;
    try {
      await cleanup();
      expect(await prisma.$queryRawUnsafe('SELECT id FROM tenants WHERE id=$1::uuid', TENANT)).toHaveLength(0);
    } finally {
      if (previousEnforcement === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
      else process.env.AUTH_ENFORCE_TENANT_RLS = previousEnforcement;
      if (previousRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRole;
    }
  }, 120000);

  it.each([
    { patient: PATIENTS[0], timeZone: 'UTC', skew: 86_400_000 },
    { patient: PATIENTS[1], timeZone: 'Asia/Kolkata', skew: -86_400_000 },
  ])('keeps write-time evidence ordered with $skew ms host skew in $timeZone', async ({ patient, timeZone, skew }) => {
    zone = timeZone;
    captures = [];
    const [baselineSession] = await prisma.$queryRawUnsafe("SELECT current_setting('TimeZone') AS zone, current_user AS role");
    expect(baselineSession.zone).toBe('UTC');
    expect(baselineSession.role).not.toBe('vhhealth_app');
    const [admission] = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions(tenant_id, patient_uid, status, encounter_id)
       VALUES ($1::uuid, $2::uuid, 'admitted', NULL) RETURNING id`, TENANT, patient,
    );
    global.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [NativeDate.now() + skew])); }
      static now() { return NativeDate.now() + skew; }
      static [Symbol.hasInstance](value) { return value instanceof NativeDate; }
    };
    rejectAudit = true;
    try {
      await expect(admissionService.markForDischarge(admission.id, ACTOR, 'DOCTOR', { tenantId: TENANT }))
        .rejects.toThrow('synthetic audit failure');
    } finally {
      rejectAudit = false;
    }
    const [rolledBack] = await prisma.$queryRawUnsafe(
      `SELECT discharge_initiated_at,
          (SELECT COUNT(*)::int FROM discharge_consults WHERE admission_id=$2::int) AS consults,
          (SELECT COUNT(*)::int FROM clinical_timeline_events WHERE tenant_id=$1::uuid AND source_id=$2::text) AS timeline
       FROM admissions WHERE tenant_id=$1::uuid AND id=$2::int`, TENANT, admission.id,
    );
    expect(rolledBack).toEqual({ discharge_initiated_at: null, consults: 0, timeline: 0 });
    captures = [];
    const opened = await admissionService.markForDischarge(admission.id, ACTOR, 'DOCTOR', { tenantId: TENANT });
    expect(captures).toHaveLength(1);
    const t0 = opened.admission.discharge_initiated_at;
    expect(t0).toEqual(captures[0].recordedAt);
    const [storedT0] = await prisma.$queryRawUnsafe(
      `SELECT FLOOR(EXTRACT(EPOCH FROM discharge_initiated_at) * 1000)::bigint AS initiated_ms,
              FLOOR(EXTRACT(EPOCH FROM billing_closed_at) * 1000)::bigint AS billing_ms,
              FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
         FROM admissions WHERE tenant_id=$1::uuid AND id=$2::int`, TENANT, admission.id,
    );
    expect(storedT0).toEqual({ initiated_ms: BigInt(t0.getTime()), billing_ms: BigInt(t0.getTime()), updated_ms: BigInt(t0.getTime()) });
    const consultClocks = await prisma.$queryRawUnsafe(
      `SELECT FLOOR(EXTRACT(EPOCH FROM requested_at) * 1000)::bigint AS requested_ms
         FROM discharge_consults WHERE tenant_id=$1::uuid AND admission_id=$2::int`, TENANT, admission.id,
    );
    expect(consultClocks.length).toBeGreaterThan(0);
    for (const consult of consultClocks) expect(consult.requested_ms).toBe(BigInt(t0.getTime()));

    // This fixture is historical evidence, not a substitute for exercising a live stock workflow.
    const [order] = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders(uid, phone, patient_id, patient_name, order_note, medication,
          status, prescribed_by, dispensed_by, dispensed_at, tenant_id, updated_at)
       SELECT $1::uuid, phone, id, name, 'Clock evidence', 'Synthetic medication', 'DISPENSED',
              $2::uuid, $2::uuid, NOW() - INTERVAL '2 days', tenant_id, NOW()
         FROM users WHERE uid=$1::uuid AND tenant_id=$3::uuid RETURNING id, patient_id`,
      patient, ACTOR, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions(patient_id, patient_uid, doctor_uid, admission_id, pharmacy_order_id,
          medication_name, status, visit_type, tenant_id)
       VALUES ($1::int, $2::uuid, $3::uuid, $4::int, $5::int, 'Synthetic medication', 'active', 'inpatient', $6::uuid)`,
      order.patient_id, patient, ACTOR, admission.id, order.id, TENANT,
    );
    await expect(admissionService.markDischargeDrugsDispensed(admission.id, ACTOR, { tenantId: TENANT }))
      .rejects.toMatchObject({ code: 'DISCHARGE_DRUG_EVIDENCE_REQUIRED' });
    expect(captures).toHaveLength(1);
    await prisma.$executeRawUnsafe('UPDATE pharmacy_orders SET dispensed_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::int', TENANT, order.id);
    const completed = await admissionService.markDischargeDrugsDispensed(admission.id, ACTOR, { tenantId: TENANT });
    expect(captures).toHaveLength(2);
    expect(completed.discharge_drugs_dispensed_at).toEqual(captures[1].recordedAt);
    expect(completed.discharge_drugs_dispensed_at.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    const [storedT3] = await prisma.$queryRawUnsafe(
      `SELECT FLOOR(EXTRACT(EPOCH FROM discharge_drugs_dispensed_at) * 1000)::bigint AS dispensed_ms,
              FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
         FROM admissions WHERE tenant_id=$1::uuid AND id=$2::int`, TENANT, admission.id,
    );
    expect(storedT3).toEqual({ dispensed_ms: BigInt(completed.discharge_drugs_dispensed_at.getTime()), updated_ms: BigInt(completed.discharge_drugs_dispensed_at.getTime()) });
    for (const { before, after, recordedAt } of captures) {
      expect(before.role).toBe('vhhealth_app');
      expect(before.zone).toBe(timeZone);
      expect(after.zone).toBe('UTC');
      expect(after.tx_id).toBe(before.tx_id);
      expect(recordedAt.getTime()).toBeGreaterThan(Number(before.started_ms));
      expect(recordedAt.getTime()).toBeLessThanOrEqual(Number(after.observed_ms));
    }
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, occurred_at FROM clinical_timeline_events
        WHERE tenant_id=$1::uuid AND source_table='admissions' AND source_id=$2 ORDER BY event_type`, TENANT, String(admission.id),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, occurred_at FROM clinical_audit_events
        WHERE tenant_id=$1::uuid AND resource_table='admissions' AND resource_id=$2 ORDER BY action`, TENANT, String(admission.id),
    );
    expect(timeline).toEqual([
      { event_type: 'discharge.drugs_dispensed', occurred_at: completed.discharge_drugs_dispensed_at },
      { event_type: 'discharge.workflow_opened', occurred_at: t0 },
    ]);
    expect(audit).toEqual(timeline.map(({ event_type, occurred_at }) => ({ action: event_type, occurred_at })));
    await expect(admissionService.markForDischarge(admission.id, ACTOR, 'DOCTOR', { tenantId: TENANT }))
      .rejects.toMatchObject({ statusCode: 409 });
    const retried = await admissionService.markDischargeDrugsDispensed(admission.id, ACTOR, { tenantId: TENANT });
    expect(retried.id).toBe(admission.id);
    const [afterRetry] = await prisma.$queryRawUnsafe(
      `SELECT FLOOR(EXTRACT(EPOCH FROM discharge_drugs_dispensed_at) * 1000)::bigint AS dispensed_ms,
          (SELECT COUNT(*)::int FROM clinical_timeline_events WHERE tenant_id=$1::uuid AND source_table='admissions' AND source_id=$2::text) AS timeline,
          (SELECT COUNT(*)::int FROM clinical_audit_events WHERE tenant_id=$1::uuid AND resource_table='admissions' AND resource_id=$2::text) AS audit
       FROM admissions WHERE tenant_id=$1::uuid AND id=$2::int`, TENANT, admission.id,
    );
    expect(afterRetry).toEqual({ dispensed_ms: storedT3.dispensed_ms, timeline: 2, audit: 2 });
    expect(captures).toHaveLength(2);
    const [session] = await prisma.$queryRawUnsafe("SELECT current_setting('TimeZone') AS zone, current_user AS role, pg_backend_pid() AS backend_pid");
    expect(session).toEqual({ ...baselineSession, backend_pid: captures.at(-1).after.backend_pid });
  }, 120000);
});
