/**
 * Real-Postgres integration test for the clinical_coding_assist module (Task 3).
 *
 * Covers:
 *   A. Happy path — generateAdmissionAiDraft produces a persisted generation
 *      whose draft.suggested_codes are annotated with system:'ICD10' + a boolean
 *      validated; the seeded real code E11.9 is validated:true; a
 *      clinical_ai_reviews row exists with decision='pending'.
 *   B. Bogus-code path — a ZZ9.9 diagnosis comes back validated:false and
 *      the generation's safety_flags contains an UNVALIDATED_CODE entry.
 *      The code is KEPT (not dropped).
 *   C. Disabled gate — when the module override is removed generateAdmissionAiDraft
 *      throws a forbidden/403 error.
 *
 * Harness pattern mirrors priorAuthAppealChain.deep.test.js + tenant-rls.deep.test.js:
 * raw prisma.$queryRawUnsafe for setup/teardown (owner path), no mocked DB,
 * DB-guarded skip when DATABASE_URL is absent.
 *
 * CRITICAL cleanup note: we DELETE the clinical_ai_tenant_modules override row
 * rather than UPDATE-ing it to false — a leftover false-override silently
 * disables the module for other tests in the shared QA DB.
 */

import prisma from '../lib/prisma.js';
import { generateAdmissionAiDraft } from '../services/ai/clinicalAiWorkflowService.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
// Stable test patient UUID — follows RFC 4122 (version 4, variant 'b').
// Must pass the strict UUID_RE in ipdSupportService (first char of 3rd group
// in [1-5], first char of 4th group in [89abAB]).
const PATIENT_UID = 'c0de0000-c0de-4000-b0de-000000000042';
// Stable test user UID for requestedBy
const TEST_USER_UID = 'c0de0000-c0de-4000-b0de-000000000043';

// ─── DB guard ─────────────────────────────────────────────────────────────────

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

if (!hasDatabaseUrl) {
  console.warn(
    'clinicalCodingAssist.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.'
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lightweight owner-path helper (same pattern as priorAuthAppealChain.deep.test.js) */
async function ownerQuery(text, params = []) {
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

/** Enable clinical_coding_assist for TENANT_ID via tenant override */
async function enableCodingModule() {
  await ownerQuery(
    `INSERT INTO clinical_ai_tenant_modules
       (tenant_id, module_key, enabled, settings, created_at, updated_at)
     VALUES ($1::uuid, 'clinical_coding_assist', true, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = true, updated_at = NOW()`,
    [TENANT_ID]
  );
}

/** Disable the module by updating the override row (used in the gate test) */
async function disableCodingModule() {
  await ownerQuery(
    `UPDATE clinical_ai_tenant_modules
     SET enabled = false, updated_at = NOW()
     WHERE tenant_id = $1::uuid AND module_key = 'clinical_coding_assist'`,
    [TENANT_ID]
  );
}

/**
 * Seed a patient user row so getPatient(PATIENT_UID) returns a real row.
 * The users table requires phone + updated_at; tenant_id defaults to the GUC
 * value but we seed it explicitly for determinism.
 *
 * Uses ON CONFLICT on both uid and phone:
 *   • uid conflict: UPDATE to bring name/phone into the expected state (idempotent
 *     across multiple suites that all seed the same patient).
 *   • phone conflict (unique index): deduplicate by first deleting any row that
 *     holds our reserved phone but a DIFFERENT uid, then upsert by uid.
 *
 * The reserved phone +91 99 0000 0042 is stable and only ever used by this test.
 */
async function seedPatientUser() {
  const PHONE = '+919900000042';
  // Remove any stale row with the same phone but a different uid (e.g. from a
  // crashed previous run that wasn't cleaned up).
  await ownerQuery(
    `DELETE FROM users WHERE phone = $1 AND uid <> $2::uuid`,
    [PHONE, PATIENT_UID]
  ).catch(() => {});
  // Upsert by uid — handles both fresh insert and re-entry after a crash.
  await ownerQuery(
    `INSERT INTO users
       (uid, phone, name, updated_at, tenant_id)
     VALUES ($1::uuid, $2, 'Test Coding Patient', NOW(), $3::uuid)
     ON CONFLICT (uid) DO UPDATE SET phone = EXCLUDED.phone, name = EXCLUDED.name, updated_at = NOW()`,
    [PATIENT_UID, PHONE, TENANT_ID]
  );
}

/** Seed an ip_admissions row; returns its integer id */
async function seedAdmission() {
  const { rows } = await ownerQuery(
    `INSERT INTO admissions
       (patient_uid, tenant_id, status, chief_complaint, admitting_diagnosis, admitted_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', 'Polyuria and polydipsia', 'Suspected Type 2 DM', NOW(), NOW(), NOW())
     RETURNING id`,
    [PATIENT_UID, TENANT_ID]
  );
  return rows[0].id;
}

/**
 * Seed a SIGNED clinical note for the admission/patient.
 * is_signed = true is required for the coding-assist fallback to produce
 * suggested_codes and avoid the NO_SIGNED_DOCUMENTATION safety flag.
 */
async function seedSignedNote(admissionId) {
  const { rows } = await ownerQuery(
    `INSERT INTO clinical_notes
       (patient_uid, tenant_id, note_type, title, content, is_addendum, is_signed, signed_at,
        version, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admission_note', 'Admission Assessment',
             '{"text":"Patient admitted with polyuria, polydipsia. HbA1c elevated. Initiating insulin."}'::jsonb,
             false, true, NOW(), 1, NOW(), NOW())
     RETURNING id`,
    [PATIENT_UID, TENANT_ID]
  );
  return rows[0].id;
  // admissionId is seeded for context; notes are looked up by patient_uid in the timeline
  void admissionId;
}

/**
 * Seed a diagnosis row with a real ICD-10 code.
 * Returns the diagnosis integer id.
 */
async function seedDiagnosis(icd10Code) {
  const { rows } = await ownerQuery(
    `INSERT INTO diagnoses
       (patient_uid, tenant_id, icd10_code, icd10_description, description, diagnosis_type, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'primary', 'active', NOW(), NOW())
     RETURNING id`,
    [
      PATIENT_UID,
      TENANT_ID,
      icd10Code,
      icd10Code === 'E11.9' ? 'Type 2 diabetes mellitus without complications' : 'Test diagnosis ' + icd10Code,
      icd10Code === 'E11.9' ? 'Type 2 diabetes mellitus without complications' : 'Bogus test diagnosis',
    ]
  );
  return rows[0].id;
}

/**
 * Deep-clean all test rows.
 * Order: generations + reviews first (no deps on admissions/diagnoses from their side),
 * then notes, diagnoses, admissions, then the tenant module override.
 * DELETE — not UPDATE-to-false — the module override (see harness pattern).
 */
async function cleanup({ admissionIds = [], noteIds = [], diagnosisIds = [] } = {}) {
  // Remove AI generations seeded by tests
  await ownerQuery(
    `DELETE FROM clinical_ai_generations WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // Remove review rows
  await ownerQuery(
    `DELETE FROM clinical_ai_reviews WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // Remove safety reviews (FK on generation_id; generations deleted above already,
  // but use patient-independent cleanup path as belt-and-suspenders)
  await ownerQuery(
    `DELETE FROM clinical_ai_safety_reviews
     WHERE generation_id NOT IN (SELECT id FROM clinical_ai_generations)`,
    []
  ).catch(() => {});

  // Remove context snapshots
  await ownerQuery(
    `DELETE FROM clinical_ai_context_snapshots WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // Remove workflow runs
  await ownerQuery(
    `DELETE FROM clinical_ai_workflow_runs
     WHERE workflow_key = 'admission_ai_draft' AND tenant_id = $1::uuid`,
    [TENANT_ID]
  ).catch(() => {});

  // Remove seeded clinical notes
  if (noteIds.length) {
    await ownerQuery(
      `DELETE FROM clinical_notes WHERE id = ANY($1::int[])`,
      [noteIds]
    ).catch(() => {});
  }

  // Remove seeded diagnoses
  if (diagnosisIds.length) {
    await ownerQuery(
      `DELETE FROM diagnoses WHERE id = ANY($1::int[])`,
      [diagnosisIds]
    ).catch(() => {});
  }

  // Remove seeded admissions
  if (admissionIds.length) {
    await ownerQuery(
      `DELETE FROM admissions WHERE id = ANY($1::int[])`,
      [admissionIds]
    ).catch(() => {});
  }

  // Remove seeded user (must come after any rows that reference patient_uid)
  await ownerQuery(
    `DELETE FROM users WHERE uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // DELETE the tenant override row — restores the pre-test state.
  // Never UPDATE-to-false (that beats the global enabled=true and pollutes
  // the shared QA DB for other tests).
  await ownerQuery(
    `DELETE FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid AND module_key = 'clinical_coding_assist'`,
    [TENANT_ID]
  ).catch(() => {});
}

// ─── Suite A: Happy path (real ICD-10 code E11.9) ─────────────────────────────

describeIfDb('A – Happy path: generateAdmissionAiDraft with real ICD-10 code E11.9', () => {
  let admissionId;
  let noteId;
  let diagnosisId;
  let draftResult;

  beforeAll(async () => {
    await enableCodingModule();
    await seedPatientUser();
    admissionId = await seedAdmission();
    noteId = await seedSignedNote(admissionId);
    diagnosisId = await seedDiagnosis('E11.9');
    // Run the actual workflow
    draftResult = await generateAdmissionAiDraft(
      admissionId,
      'clinical_coding_assist',
      TEST_USER_UID,
      null
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup({
      admissionIds: [admissionId].filter(Boolean),
      noteIds: [noteId].filter(Boolean),
      diagnosisIds: [diagnosisId].filter(Boolean),
    });
    await prisma.$disconnect().catch(() => {});
  });

  it('A1 – generateAdmissionAiDraft resolves without throwing', () => {
    expect(draftResult).toBeDefined();
    expect(draftResult.draft).toBeDefined();
  });

  it('A2 – draft.suggested_codes is a non-empty array with ICD10 annotations', () => {
    const codes = draftResult?.draft?.suggested_codes;
    expect(Array.isArray(codes)).toBe(true);
    expect(codes.length).toBeGreaterThan(0);
    for (const entry of codes) {
      expect(entry).toHaveProperty('system', 'ICD10');
      expect(typeof entry.validated).toBe('boolean');
      expect(entry).toHaveProperty('code');
    }
  });

  it('A3 – seeded real code E11.9 is validated:true in the annotated output', () => {
    const codes = draftResult?.draft?.suggested_codes ?? [];
    const e119 = codes.find((c) => c.code === 'E11.9');
    expect(e119).toBeDefined();
    expect(e119.validated).toBe(true);
  });

  it('A4 – a clinical_ai_generations row is persisted with the annotated suggested_codes', async () => {
    const { rows } = await ownerQuery(
      `SELECT id, draft, safety_flags FROM clinical_ai_generations
       WHERE patient_uid = $1::uuid AND module_key = 'clinical_coding_assist'
       ORDER BY created_at DESC LIMIT 1`,
      [PATIENT_UID]
    );
    expect(rows.length).toBe(1);
    const draft = typeof rows[0].draft === 'string' ? JSON.parse(rows[0].draft) : rows[0].draft;
    expect(Array.isArray(draft?.suggested_codes)).toBe(true);
    expect(draft.suggested_codes.length).toBeGreaterThan(0);
    for (const entry of draft.suggested_codes) {
      expect(entry.system).toBe('ICD10');
      expect(typeof entry.validated).toBe('boolean');
    }
  });

  it('A5 – a clinical_ai_reviews row exists with decision=pending', async () => {
    const { rows: genRows } = await ownerQuery(
      `SELECT id FROM clinical_ai_generations
       WHERE patient_uid = $1::uuid AND module_key = 'clinical_coding_assist'
       ORDER BY created_at DESC LIMIT 1`,
      [PATIENT_UID]
    );
    expect(genRows.length).toBe(1);
    const generationId = genRows[0].id;

    const { rows: reviewRows } = await ownerQuery(
      `SELECT id, decision FROM clinical_ai_reviews
       WHERE generation_id = $1 AND tenant_id = $2::uuid
       LIMIT 1`,
      [generationId, TENANT_ID]
    );
    expect(reviewRows.length).toBeGreaterThanOrEqual(1);
    expect(reviewRows[0].decision).toBe('pending');
  });
});

// ─── Suite B: Bogus-code path (ZZ9.9 → validated:false + UNVALIDATED_CODE flag) ──

describeIfDb('B – Bogus-code path: ZZ9.9 is kept but flagged as UNVALIDATED_CODE', () => {
  let admissionId;
  let noteId;
  let diagnosisId;
  let draftResult;

  beforeAll(async () => {
    await enableCodingModule();
    await seedPatientUser();
    admissionId = await seedAdmission();
    noteId = await seedSignedNote(admissionId);
    diagnosisId = await seedDiagnosis('ZZ9.9');
    draftResult = await generateAdmissionAiDraft(
      admissionId,
      'clinical_coding_assist',
      TEST_USER_UID,
      null
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup({
      admissionIds: [admissionId].filter(Boolean),
      noteIds: [noteId].filter(Boolean),
      diagnosisIds: [diagnosisId].filter(Boolean),
    });
    await prisma.$disconnect().catch(() => {});
  });

  it('B1 – generateAdmissionAiDraft resolves without throwing', () => {
    expect(draftResult).toBeDefined();
  });

  it('B2 – ZZ9.9 is present in suggested_codes and validated:false', () => {
    const codes = draftResult?.draft?.suggested_codes ?? [];
    const bogus = codes.find((c) => c.code === 'ZZ9.9');
    expect(bogus).toBeDefined();
    expect(bogus.validated).toBe(false);
  });

  it('B3 – ZZ9.9 is KEPT in the output (not dropped)', () => {
    const codes = draftResult?.draft?.suggested_codes ?? [];
    expect(codes.some((c) => c.code === 'ZZ9.9')).toBe(true);
  });

  it('B4 – safety_flags contains an UNVALIDATED_CODE entry', () => {
    const flags = draftResult?.safety_flags ?? [];
    const codeFlag = flags.find(
      (f) => f.type === 'UNVALIDATED_CODE' || f.code === 'UNVALIDATED_CODE'
    );
    expect(codeFlag).toBeDefined();
  });

  it('B5 – the persisted generation also carries UNVALIDATED_CODE in safety_flags', async () => {
    const { rows } = await ownerQuery(
      `SELECT id, safety_flags FROM clinical_ai_generations
       WHERE patient_uid = $1::uuid AND module_key = 'clinical_coding_assist'
       ORDER BY created_at DESC LIMIT 1`,
      [PATIENT_UID]
    );
    expect(rows.length).toBe(1);
    const flags =
      typeof rows[0].safety_flags === 'string'
        ? JSON.parse(rows[0].safety_flags)
        : rows[0].safety_flags;
    expect(Array.isArray(flags)).toBe(true);
    const codeFlag = flags.find(
      (f) => f.type === 'UNVALIDATED_CODE' || f.code === 'UNVALIDATED_CODE'
    );
    expect(codeFlag).toBeDefined();
  });
});

// ─── Suite C: Disabled-gate — module disabled → throws forbidden ───────────────

describeIfDb('C – Disabled gate: forbidden when clinical_coding_assist is off', () => {
  let admissionId;
  let noteId;
  let diagnosisId;

  beforeAll(async () => {
    // Enable first, seed, then disable
    await enableCodingModule();
    await seedPatientUser();
    admissionId = await seedAdmission();
    noteId = await seedSignedNote(admissionId);
    diagnosisId = await seedDiagnosis('E11.9');
    await disableCodingModule();
  }, 30_000);

  afterAll(async () => {
    await cleanup({
      admissionIds: [admissionId].filter(Boolean),
      noteIds: [noteId].filter(Boolean),
      diagnosisIds: [diagnosisId].filter(Boolean),
    });
    await prisma.$disconnect().catch(() => {});
  });

  it('C1 – generateAdmissionAiDraft throws a forbidden error when module is disabled', async () => {
    await expect(
      generateAdmissionAiDraft(admissionId, 'clinical_coding_assist', TEST_USER_UID, null)
    ).rejects.toThrow(/disabled|forbidden/i);
  });

  it('C2 – the thrown error has statusCode 403', async () => {
    let caught;
    try {
      await generateAdmissionAiDraft(admissionId, 'clinical_coding_assist', TEST_USER_UID, null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.statusCode).toBe(403);
  });
});
