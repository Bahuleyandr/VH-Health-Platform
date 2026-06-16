/**
 * Real-Postgres integration test for the clinician_ehr_query module (Task 4).
 *
 * Covers:
 *   A. scope='both' happy path — answerEhrQuery resolves the active admission,
 *      assembles a dual-scope packet (current admission + prior history), runs
 *      the template provider (used_ai=false), and persists ONE
 *      clinical_ai_generations audit row (task_type/module_key='clinician_ehr_query',
 *      used_ai=false, metadata->>'scope'='both'). window.current_admission_id
 *      points at the seeded admission and event_count >= 2 (>=1 current + >=1 history).
 *   B. scope='current_admission' excludes prior history — event_count drops below
 *      the both-scope count while current_admission_id stays pinned.
 *   C. Disabled gate — once the tenant override is DELETED the module falls back
 *      to its global enabled:false default and answerEhrQuery throws a 403
 *      (EHR_QUERY_MODULE_DISABLED).
 *
 * Harness pattern mirrors clinicalCodingAssist.deep.test.js + priorAuthAppealChain
 * .deep.test.js: raw prisma.$queryRawUnsafe for setup/teardown (owner path), no
 * mocked DB, DB-guarded skip when DATABASE_URL is absent.
 *
 * CRITICAL cleanup note: we DELETE the clinical_ai_tenant_modules override row
 * rather than UPDATE-ing it to false — a leftover override (true OR false)
 * changes the module's effective state for other suites in the shared QA DB.
 * Suite C also relies on the DELETE being the disable mechanism (the global
 * default is enabled:false), so no UPDATE-to-false helper is needed at all.
 *
 * Section routing (from clinicalTimelineService.collectAdmissionClinicalContext +
 * clinicianEhrQueryService.answerEhrQuery):
 *   • The current-admission packet pulls getPatientTimeline(dateFrom=admitted_at,
 *     dateTo=discharged_at) — this includes the admission event itself PLUS any
 *     diagnosis whose created_at >= admitted_at.
 *   • Prior history pulls getPatientTimeline(dateFrom=now-365d, dateTo=admitted_at)
 *     and then strictly filters created_at < admitted_at.
 * So we seed:
 *   – admitted_at = now()-2 days
 *   – CURRENT diagnosis created_at = now()-1 day  → current section
 *   – HISTORY diagnosis created_at = now()-40 days → prior history
 * Diagnosis timeline events filter/order on created_at, so created_at is the
 * lever that decides the section (NOT onset_date).
 */

import prisma from '../lib/prisma.js';
import { answerEhrQuery } from '../services/ai/clinicianEhrQueryService.js';
import { listClinicalAiModules } from '../services/ai/clinicalAiModuleService.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
const MODULE_KEY = 'clinician_ehr_query';
// Stable test patient UUID — RFC 4122 v4 (3rd group starts [1-5], 4th [89abAB]).
const PATIENT_UID = 'ec110000-ec11-4000-bec1-000000000071';
// Stable test staff UID for req.user.uid (lands in generated_by).
const STAFF_UID = 'ec110000-ec11-4000-bec1-000000000072';
const PHONE = '+919900000071';

// ─── DB guard ─────────────────────────────────────────────────────────────────

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

if (!hasDatabaseUrl) {
  console.warn(
    'clinicianEhrQuery.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.'
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lightweight owner-path helper (same pattern as clinicalCodingAssist.deep.test.js) */
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
 * Ensure the clinician_ehr_query row exists in the clinical_ai_modules registry
 * table. clinical_ai_tenant_modules.module_key has a FK to that table
 * (clinical_ai_tenant_modules_module_key_fkey); the module is registered only
 * in the JS CLINICAL_AI_MODULES array, so it lands in the DB lazily via
 * seedMissingModules() — which listClinicalAiModules({ refresh:true }) triggers.
 * Without this the override INSERT below fails with 23503.
 */
async function seedModuleRegistry() {
  await listClinicalAiModules({ refresh: true });
}

/** Enable clinician_ehr_query for TENANT_ID via tenant override (enabled=true) */
async function enableEhrQueryModule() {
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

/** DELETE the tenant override row — restores the global enabled:false default. */
async function deleteEhrQueryOverride() {
  await ownerQuery(
    `DELETE FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid AND module_key = $2`,
    [TENANT_ID, MODULE_KEY]
  );
}

/**
 * Seed a patient user row so collectAdmissionClinicalContext (via getPatient)
 * returns a real row. users requires phone + updated_at; tenant_id seeded
 * explicitly for determinism. De-dupe any stale row holding our reserved phone
 * under a different uid before upserting by uid.
 */
async function seedPatientUser() {
  await ownerQuery(
    `DELETE FROM users WHERE phone = $1 AND uid <> $2::uuid`,
    [PHONE, PATIENT_UID]
  ).catch(() => {});
  await ownerQuery(
    `INSERT INTO users
       (uid, phone, name, updated_at, tenant_id)
     VALUES ($1::uuid, $2, 'Test EHR Query Patient', NOW(), $3::uuid)
     ON CONFLICT (uid) DO UPDATE SET phone = EXCLUDED.phone, name = EXCLUDED.name, updated_at = NOW()`,
    [PATIENT_UID, PHONE, TENANT_ID]
  );
}

/**
 * Seed an ACTIVE admission: status='admitted', discharged_at=NULL,
 * admitted_at = now()-2 days. Returns its integer id.
 */
async function seedActiveAdmission() {
  const { rows } = await ownerQuery(
    `INSERT INTO admissions
       (patient_uid, tenant_id, status, chief_complaint, admitting_diagnosis,
        admitted_at, discharged_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', 'Reduced urine output',
             'Acute kidney injury', NOW() - INTERVAL '2 days', NULL,
             NOW() - INTERVAL '2 days', NOW())
     RETURNING id`,
    [PATIENT_UID, TENANT_ID]
  );
  return rows[0].id;
}

/**
 * Seed a diagnosis row with an explicit created_at offset (days in the past).
 * created_at is the column the diagnosis timeline collector filters/orders on,
 * so it decides whether the event lands in the current-admission section
 * (created_at >= admitted_at) or prior history (created_at < admitted_at).
 * Returns the diagnosis integer id.
 */
async function seedDiagnosis({ icd10Code, description, daysAgo }) {
  const { rows } = await ownerQuery(
    `INSERT INTO diagnoses
       (patient_uid, tenant_id, icd10_code, icd10_description, description,
        diagnosis_type, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'primary', 'active',
             NOW() - ($6 || ' days')::interval, NOW())
     RETURNING id`,
    [PATIENT_UID, TENANT_ID, icd10Code, description, description, String(daysAgo)]
  );
  return rows[0].id;
}

/**
 * Deep-clean all test rows.
 * Order: generations + reviews first, then diagnoses, admissions, the user,
 * then the tenant module override. DELETE — not UPDATE-to-false — the override.
 */
async function cleanup({ admissionIds = [], diagnosisIds = [] } = {}) {
  await ownerQuery(
    `DELETE FROM clinical_ai_generations WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  await ownerQuery(
    `DELETE FROM clinical_ai_reviews WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  if (diagnosisIds.length) {
    await ownerQuery(
      `DELETE FROM diagnoses WHERE id = ANY($1::int[])`,
      [diagnosisIds]
    ).catch(() => {});
  }

  if (admissionIds.length) {
    await ownerQuery(
      `DELETE FROM admissions WHERE id = ANY($1::int[])`,
      [admissionIds]
    ).catch(() => {});
  }

  await ownerQuery(
    `DELETE FROM users WHERE uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // DELETE the override — restores the pre-test no-row state (global enabled:false).
  await deleteEhrQueryOverride().catch(() => {});
}

/** Build the req object the orchestrator expects. */
function buildReq() {
  return { tenantId: TENANT_ID, user: { uid: STAFF_UID }, tenant_region: 'in' };
}

// ─── Suite A: scope='both' happy path + audit row ──────────────────────────────

describeIfDb('A – scope=both: dual-scope answer + persisted audit row', () => {
  let admissionId;
  let currentDxId;
  let historyDxId;
  let res;

  beforeAll(async () => {
    await enableEhrQueryModule();
    await seedPatientUser();
    admissionId = await seedActiveAdmission();
    // CURRENT-admission event: created 1 day ago (>= admitted_at = 2 days ago).
    currentDxId = await seedDiagnosis({
      icd10Code: 'N17.9',
      description: 'Acute kidney injury, unspecified',
      daysAgo: 1,
    });
    // HISTORY event: created 40 days ago (< admitted_at, within 12 months).
    historyDxId = await seedDiagnosis({
      icd10Code: 'E11.9',
      description: 'Type 2 diabetes mellitus without complications',
      daysAgo: 40,
    });

    res = await answerEhrQuery({
      patientUid: PATIENT_UID,
      question: 'what is the creatinine/diagnosis history?',
      scope: 'both',
      req: buildReq(),
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup({
      admissionIds: [admissionId].filter(Boolean),
      diagnosisIds: [currentDxId, historyDxId].filter(Boolean),
    });
    await prisma.$disconnect().catch(() => {});
  });

  it('A1 – answerEhrQuery resolves with scope=both and the seeded admission pinned', () => {
    expect(res).toBeDefined();
    expect(res.scope).toBe('both');
    expect(res.window.current_admission_id).toBe(admissionId);
  });

  it('A2 – used_ai is false (committed provider is template)', () => {
    expect(res.used_ai).toBe(false);
  });

  it('A3 – window.event_count >= 2 (>=1 current + >=1 history)', () => {
    expect(res.window.event_count).toBeGreaterThanOrEqual(2);
  });

  it('A4 – exactly one clinical_ai_generations audit row exists for this patient', async () => {
    const { rows } = await ownerQuery(
      `SELECT id, task_type, module_key, used_ai, metadata
       FROM clinical_ai_generations
       WHERE patient_uid = $1::uuid AND task_type = 'clinician_ehr_query'`,
      [PATIENT_UID]
    );
    expect(rows).toHaveLength(1);
  });

  it('A5 – the audit row has module_key=clinician_ehr_query, used_ai=false, metadata.scope=both', async () => {
    const { rows } = await ownerQuery(
      `SELECT module_key, used_ai, admission_id, metadata->>'scope' AS scope
       FROM clinical_ai_generations
       WHERE patient_uid = $1::uuid AND task_type = 'clinician_ehr_query'
       ORDER BY created_at DESC LIMIT 1`,
      [PATIENT_UID]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].module_key).toBe('clinician_ehr_query');
    expect(rows[0].used_ai).toBe(false);
    expect(rows[0].scope).toBe('both');
    expect(Number(rows[0].admission_id)).toBe(Number(admissionId));
  });
});

// ─── Suite B: scope='current_admission' excludes prior history ─────────────────

describeIfDb('B – scope=current_admission: prior history dropped', () => {
  let admissionId;
  let currentDxId;
  let historyDxId;
  let bothCount;
  let currentCount;
  let currentRes;

  beforeAll(async () => {
    await enableEhrQueryModule();
    await seedPatientUser();
    admissionId = await seedActiveAdmission();
    currentDxId = await seedDiagnosis({
      icd10Code: 'N17.9',
      description: 'Acute kidney injury, unspecified',
      daysAgo: 1,
    });
    historyDxId = await seedDiagnosis({
      icd10Code: 'E11.9',
      description: 'Type 2 diabetes mellitus without complications',
      daysAgo: 40,
    });

    const bothRes = await answerEhrQuery({
      patientUid: PATIENT_UID,
      question: 'summarise the chart',
      scope: 'both',
      req: buildReq(),
    });
    bothCount = bothRes.window.event_count;

    currentRes = await answerEhrQuery({
      patientUid: PATIENT_UID,
      question: 'summarise the chart',
      scope: 'current_admission',
      req: buildReq(),
    });
    currentCount = currentRes.window.event_count;
  }, 60_000);

  afterAll(async () => {
    await cleanup({
      admissionIds: [admissionId].filter(Boolean),
      diagnosisIds: [currentDxId, historyDxId].filter(Boolean),
    });
    await prisma.$disconnect().catch(() => {});
  });

  it('B1 – current_admission scope keeps the admission pinned', () => {
    expect(currentRes.scope).toBe('current_admission');
    expect(currentRes.window.current_admission_id).toBe(admissionId);
  });

  it('B2 – current_admission event_count is strictly LESS than the both-scope count', () => {
    expect(currentCount).toBeLessThan(bothCount);
  });

  it('B3 – current_admission still has at least the current-section events', () => {
    // The current section contains at minimum the admission event + the
    // current-admission diagnosis, so it is never empty.
    expect(currentCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── Suite C: module disabled → 403 ────────────────────────────────────────────

describeIfDb('C – disabled gate: 403 when the tenant override is removed', () => {
  let admissionId;
  let currentDxId;

  beforeAll(async () => {
    // Enable + seed so the ONLY thing the gate test changes is the override.
    await enableEhrQueryModule();
    await seedPatientUser();
    admissionId = await seedActiveAdmission();
    currentDxId = await seedDiagnosis({
      icd10Code: 'N17.9',
      description: 'Acute kidney injury, unspecified',
      daysAgo: 1,
    });
    // Disable by DELETING the override → falls back to global enabled:false.
    await deleteEhrQueryOverride();
  }, 30_000);

  afterAll(async () => {
    await cleanup({
      admissionIds: [admissionId].filter(Boolean),
      diagnosisIds: [currentDxId].filter(Boolean),
    });
    await prisma.$disconnect().catch(() => {});
  });

  it('C1 – answerEhrQuery rejects with statusCode 403 when the module is disabled', async () => {
    await expect(
      answerEhrQuery({
        patientUid: PATIENT_UID,
        question: 'should not run',
        scope: 'both',
        req: buildReq(),
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('C2 – the thrown error carries code EHR_QUERY_MODULE_DISABLED', async () => {
    let caught;
    try {
      await answerEhrQuery({
        patientUid: PATIENT_UID,
        question: 'should not run',
        scope: 'both',
        req: buildReq(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EHR_QUERY_MODULE_DISABLED');
  });

  it('C3 – no audit row was written for the disabled-gate calls', async () => {
    const { rows } = await ownerQuery(
      `SELECT id FROM clinical_ai_generations
       WHERE patient_uid = $1::uuid AND task_type = 'clinician_ehr_query'`,
      [PATIENT_UID]
    );
    expect(rows).toHaveLength(0);
  });
});
