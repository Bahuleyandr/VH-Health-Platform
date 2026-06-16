/**
 * Real-Postgres integration test for surfacing the NEWS2 score onto the CDS
 * card pipeline (deterioration_early_warning module).
 *
 * recordNEWS2 (services/clinical/news2Service.js) computes + persists a
 * news2_scores row. After this feature it ALSO best-effort calls
 * surfaceNews2Cds (services/cds/deteriorationEarlyWarningService.js), which —
 * when the deterioration_early_warning module is enabled for the patient's
 * tenant, for an adult patient, on an escalating score — raises a cds_alerts
 * row (alert_type='NEWS2_DETERIORATION') via persistCdsAlert with escalation-
 * only de-dup. This test exercises that end to end against a real DB.
 *
 * Covers:
 *   1. Critical record (score >=7) → a cds_alerts NEWS2_DETERIORATION row with
 *      severity='critical', non-null tenant_id; getActiveAlerts surfaces it.
 *   2. Normal record → no NEW NEWS2 cds_alert (count unchanged).
 *   3. Second identical critical record → still exactly ONE unacknowledged
 *      NEWS2_DETERIORATION alert (escalation-only de-dup).
 *   4. Module disabled (override deleted) → a fresh critical record raises no
 *      new NEWS2 cds_alert.
 *   5. The news2_scores row is written on EVERY recordNEWS2 (surfacing is
 *      additive, not a replacement).
 *
 * Harness pattern mirrors clinicianEhrQuery.deep.test.js / priorAuthAppealChain
 * .deep.test.js: raw prisma.$queryRawUnsafe for setup/teardown (owner path), no
 * mocked DB, DB-guarded skip when DATABASE_URL is absent. UNIQUE tenant + patient
 * per run so the shared QA DB has zero residue and no cross-suite collision.
 *
 * Module-registry note: clinical_ai_tenant_modules.module_key has an FK to the
 * clinical_ai_modules registry, seeded lazily from the JS module list. We call
 * listClinicalAiModules({ refresh:true }) before inserting the override so the
 * override INSERT can't 23503.
 *
 * Tenant note: BOTH clinical_ai_tenant_modules.tenant_id and users.tenant_id
 * FK to tenants(id). Because we use a unique tenant per run (not the shared
 * DEFAULT_TENANT_ID the sibling deep tests reuse), we must seed a real tenants
 * row before the override/user inserts, and tear it down last in cleanup.
 */

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { recordNEWS2 } from '../services/clinical/news2Service.js';
import { getActiveAlerts } from '../services/emr/cdsEngine.js';
import { listClinicalAiModules } from '../services/ai/clinicalAiModuleService.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODULE_KEY = 'deterioration_early_warning';
const ALERT_TYPE = 'NEWS2_DETERIORATION';

// Unique-per-run identifiers — zero collision with real rows or other suites.
const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const STAFF_UID = randomUUID();
const PHONE = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

// Escalating vitals → NEWS2 = 3(RR26)+3(SpO2 90)+2(O2)+0(T37)+2(SBP95)+2(HR130)+0(A) = 12 → critical (>=7)
const CRITICAL_VITALS = {
  respiration_rate: 26,
  spo2: 90,
  supplemental_o2: true,
  temperature: 37,
  systolic_bp: 95,
  heart_rate: 130,
  consciousness: 'A',
};

// Healthy vitals → NEWS2 = 0 → below threshold, no anyParamThree.
const NORMAL_VITALS = {
  respiration_rate: 16,
  spo2: 98,
  temperature: 37,
  systolic_bp: 120,
  heart_rate: 72,
  consciousness: 'A',
};

// ─── DB guard ─────────────────────────────────────────────────────────────────

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

if (!hasDatabaseUrl) {
  console.warn(
    'news2CdsSurfacing.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.'
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lightweight owner-path helper (same pattern as clinicianEhrQuery.deep.test.js) */
async function ownerQuery(text, params = []) {
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

/**
 * Ensure the deterioration_early_warning row exists in the clinical_ai_modules
 * registry (FK target of clinical_ai_tenant_modules.module_key). The module is
 * declared only in the JS module list and lands in the DB lazily via
 * seedMissingModules(), which listClinicalAiModules({ refresh:true }) triggers.
 * Without this the override INSERT below can fail with 23503.
 */
async function seedModuleRegistry() {
  await listClinicalAiModules({ refresh: true });
}

/**
 * Seed a real tenants row for our unique TENANT_ID — FK target of both
 * clinical_ai_tenant_modules.tenant_id and users.tenant_id. slug + name are the
 * only NOT-NULL columns without a default; the rest (region/compliance/status/
 * settings/timestamps) carry defaults.
 */
async function seedTenant() {
  await ownerQuery(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, 'NEWS2 CDS Test Tenant')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, `news2-cds-test-${TENANT_ID.slice(0, 8)}`]
  );
}

/** Enable deterioration_early_warning for TENANT_ID via tenant override (enabled=true). */
async function enableModule() {
  await seedModuleRegistry();
  await ownerQuery(
    `INSERT INTO clinical_ai_tenant_modules
       (tenant_id, module_key, enabled, settings, created_at, updated_at)
     VALUES ($1::uuid, $2, true, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = true, updated_at = NOW()`,
    [TENANT_ID, MODULE_KEY]
  );
}

/** DELETE the tenant override → falls back to the global enabled:false default. */
async function deleteModuleOverride() {
  await ownerQuery(
    `DELETE FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid AND module_key = $2`,
    [TENANT_ID, MODULE_KEY]
  );
}

/**
 * Seed an ADULT, non-pregnant patient user. resolvePatientContext classifies by
 * users.birthday (AGE < 12 → paediatric) + is_pregnant; a birthday ~50y ago with
 * is_pregnant=false is unambiguously adult. users requires phone + updated_at;
 * tenant_id seeded explicitly so the alert lands under our unique tenant.
 */
async function seedAdultPatient() {
  await ownerQuery(
    `INSERT INTO users
       (uid, phone, name, birthday, is_pregnant, updated_at, tenant_id)
     VALUES ($1::uuid, $2, 'Test NEWS2 CDS Patient',
             (NOW() - INTERVAL '50 years')::date, FALSE, NOW(), $3::uuid)
     ON CONFLICT (uid) DO UPDATE
       SET phone = EXCLUDED.phone, birthday = EXCLUDED.birthday,
           is_pregnant = FALSE, updated_at = NOW(), tenant_id = EXCLUDED.tenant_id`,
    [PATIENT_UID, PHONE, TENANT_ID]
  );
}

/** Count unacknowledged NEWS2_DETERIORATION cds_alerts for the test patient. */
async function countActiveNews2Alerts() {
  const { rows } = await ownerQuery(
    `SELECT COUNT(*)::int AS n FROM cds_alerts
       WHERE patient_uid = $1::uuid AND alert_type = $2 AND acknowledged = false`,
    [PATIENT_UID, ALERT_TYPE]
  );
  return rows[0]?.n ?? 0;
}

/** Count news2_scores rows for the test patient. */
async function countNews2Scores() {
  const { rows } = await ownerQuery(
    `SELECT COUNT(*)::int AS n FROM news2_scores WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  );
  return rows[0]?.n ?? 0;
}

/** Acknowledge every standing NEWS2 alert so the next test isn't de-dup gated. */
async function ackAllNews2Alerts() {
  await ownerQuery(
    `UPDATE cds_alerts SET acknowledged = true, ack_at = NOW()
       WHERE patient_uid = $1::uuid AND alert_type = $2 AND acknowledged = false`,
    [PATIENT_UID, ALERT_TYPE]
  );
}

/**
 * Deep-clean ALL rows this test created. Order: cds_alerts + news2_scores
 * (keyed on patient_uid), then the user, then the tenant module override.
 * DELETE the override (never UPDATE-to-false) so the shared QA DB returns to
 * its pre-test no-row state.
 */
async function cleanup() {
  await ownerQuery(
    `DELETE FROM cds_alerts WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});
  await ownerQuery(
    `DELETE FROM news2_scores WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});
  await ownerQuery(
    `DELETE FROM users WHERE uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});
  await deleteModuleOverride().catch(() => {});
  // Tenant last — both the user and the override FK into it (override is
  // ON DELETE CASCADE, but we remove it explicitly above for clarity).
  await ownerQuery(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    [TENANT_ID]
  ).catch(() => {});
}

// ─── Suite ─────────────────────────────────────────────────────────────────────

describeIfDb('NEWS2 → CDS surfacing (deterioration_early_warning, real PG)', () => {
  beforeAll(async () => {
    await cleanup(); // clear any orphan rows from a prior crashed run
    await seedTenant();
    await enableModule();
    await seedAdultPatient();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('1 – a critical NEWS2 (score >=7) raises a NEWS2_DETERIORATION cds_alert (severity=critical, tenant set) surfaced by getActiveAlerts', async () => {
    const beforeScores = await countNews2Scores();

    const record = await recordNEWS2(PATIENT_UID, CRITICAL_VITALS, STAFF_UID);
    expect(record).toBeDefined();
    expect(Number(record.total_score)).toBeGreaterThanOrEqual(7);

    // news2_scores row written.
    expect(await countNews2Scores()).toBe(beforeScores + 1);

    // The CDS alert row exists with the right shape.
    const { rows } = await ownerQuery(
      `SELECT alert_type, severity, tenant_id, acknowledged
         FROM cds_alerts
        WHERE patient_uid = $1::uuid AND alert_type = $2
        ORDER BY created_at DESC LIMIT 1`,
      [PATIENT_UID, ALERT_TYPE]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].alert_type).toBe(ALERT_TYPE);
    expect(rows[0].severity).toBe('critical');
    expect(rows[0].tenant_id).toBeTruthy();
    expect(String(rows[0].tenant_id)).toBe(TENANT_ID);

    // getActiveAlerts surfaces it (unacknowledged).
    const active = await getActiveAlerts(PATIENT_UID);
    expect(active.some((a) => a.alert_type === ALERT_TYPE && a.severity === 'critical')).toBe(true);

    expect(await countActiveNews2Alerts()).toBe(1);
  }, 30_000);

  it('2 – a NORMAL NEWS2 record raises no new NEWS2 cds_alert (count unchanged)', async () => {
    const before = await countActiveNews2Alerts();
    const beforeScores = await countNews2Scores();

    const record = await recordNEWS2(PATIENT_UID, NORMAL_VITALS, STAFF_UID);
    expect(Number(record.total_score)).toBeLessThan(5);

    // news2_scores still written (additive).
    expect(await countNews2Scores()).toBe(beforeScores + 1);
    // No new NEWS2 CDS alert.
    expect(await countActiveNews2Alerts()).toBe(before);
  }, 30_000);

  it('3 – a second identical critical record keeps exactly ONE unacknowledged NEWS2 alert (escalation-only de-dup)', async () => {
    const beforeScores = await countNews2Scores();

    const record = await recordNEWS2(PATIENT_UID, CRITICAL_VITALS, STAFF_UID);
    expect(Number(record.total_score)).toBeGreaterThanOrEqual(7);

    // news2_scores still written each time.
    expect(await countNews2Scores()).toBe(beforeScores + 1);
    // De-dup: same critical severity does not add a second standing alert.
    expect(await countActiveNews2Alerts()).toBe(1);
  }, 30_000);

  it('4 – with the module disabled (override deleted), a fresh critical record raises no new NEWS2 cds_alert', async () => {
    // Acknowledge the standing alert first so the ONLY thing that could block a
    // new alert is the disabled-module gate (not escalation-only de-dup).
    await ackAllNews2Alerts();
    expect(await countActiveNews2Alerts()).toBe(0);

    await deleteModuleOverride();
    const beforeScores = await countNews2Scores();

    const record = await recordNEWS2(PATIENT_UID, CRITICAL_VITALS, STAFF_UID);
    expect(Number(record.total_score)).toBeGreaterThanOrEqual(7);

    // news2_scores still written even when CDS surfacing is gated off.
    expect(await countNews2Scores()).toBe(beforeScores + 1);
    // No NEW unacknowledged NEWS2 alert — the module gate blocked the surfacing.
    expect(await countActiveNews2Alerts()).toBe(0);
  }, 30_000);
});
