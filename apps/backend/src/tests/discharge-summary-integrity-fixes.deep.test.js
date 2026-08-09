// Phase-3 discharge-summary integrity fixes (A-M3 / A-M4 / A-L5) — proven
// against the real service + real DB.
//
//   A-M3: setSectionTranslation must reject signed/delivered summaries (409),
//         run atomically, and emit the legacy audit row + canonical
//         timeline/audit pair (amendable-record idempotency keys, with an
//         effective-state no-op guard so exact retries emit nothing).
//   A-M4: createDraft must validate admission_id (exists, same tenant, same
//         patient); sign() must predicate the admissions summary_signed_at
//         stamp on tenant + patient so a mismatched admission can never have
//         its discharge gate satisfied — the sign aborts and rolls back.
//   A-L5: createDraft is one transaction — a failing section insert leaves no
//         signable partial summary.
//
// Self-isolating fixtures (unique tenants + patients + templates per run).

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import * as dischargeService from '../services/discharge/dischargeService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const OTHER_PATIENT_UID = randomUUID();
const FOREIGN_PATIENT_UID = randomUUID();
const TXN_PATIENT_UID = randomUUID();
const SIGNER_UID = randomUUID();
const ALL_PATIENT_UIDS = [PATIENT_UID, OTHER_PATIENT_UID, FOREIGN_PATIENT_UID, TXN_PATIENT_UID];

const TEMPLATE_CODE = `INTEG-${TENANT_ID.slice(0, 8)}`;
const DUP_TEMPLATE_CODE = `INTEGDUP-${TENANT_ID.slice(0, 8)}`;

function randomPhone() {
  return `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

let admissionId;               // TENANT / PATIENT
let otherPatientAdmissionId;   // TENANT / OTHER_PATIENT
let foreignAdmissionId;        // OTHER_TENANT / FOREIGN_PATIENT

async function insertUser(uid, name, tenantId) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', true, $4::uuid, NOW())`,
    uid, randomPhone(), name, tenantId,
  );
}

async function insertAdmission(patientUid, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions
       (patient_uid, tenant_id, status, chief_complaint, admitting_diagnosis,
        admitted_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', 'Integrity test', 'Integrity test dx',
             NOW(), NOW(), NOW())
     RETURNING id`,
    patientUid, tenantId,
  );
  return Number(rows[0].id);
}

async function summariesForPatient(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, admission_id FROM discharge_summaries WHERE patient_uid = $1::uuid`,
    patientUid,
  );
}

async function translationTimelineEvents() {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, patient_uid
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = 'discharge_summary.translation_set'`,
    PATIENT_UID,
  );
}

async function translationAuditEvents() {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = 'discharge_summary.translation_set'`,
    PATIENT_UID,
  );
}

async function fillRequiredSections(summaryId) {
  await dischargeService.updateSection({
    tenantId: TENANT_ID, id: summaryId, section_key: 'diagnosis',
    body: 'Community-acquired pneumonia, resolved.', edited_by: SIGNER_UID,
  });
  await dischargeService.updateSection({
    tenantId: TENANT_ID, id: summaryId, section_key: 'discharge_medications',
    body: 'Amoxicillin 500mg PO TDS x5 days', edited_by: SIGNER_UID,
  });
}

async function cleanup() {
  for (const uid of ALL_PATIENT_UIDS) {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM discharge_summary_sections WHERE discharge_summary_id IN
         (SELECT id FROM discharge_summaries WHERE patient_uid = $1::uuid)`, uid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_templates WHERE code IN ($1, $2)`,
    TEMPLATE_CODE, DUP_TEMPLATE_CODE,
  ).catch(() => {});
  // appendDischargeAudit rows are tenant-stamped (GUC default) and FK-block the
  // tenants delete. Superuser test connections bypass the append-only guard.
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_ID, OTHER_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT_ID, OTHER_TENANT_ID,
  ).catch(() => {});
}

d('Discharge summary integrity fixes (A-M3 / A-M4 / A-L5)', () => {
  let linkedSummaryId;      // draft linked to PATIENT's own admission
  let translationSummaryId; // unlinked draft used for the translation tests

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'Discharge Integrity Tenant'),
              ($3::uuid, $4, 'Discharge Integrity Other Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `disch-integ-${TENANT_ID.slice(0, 8)}`,
      OTHER_TENANT_ID, `disch-integ-${OTHER_TENANT_ID.slice(0, 8)}`,
    );
    await insertUser(PATIENT_UID, 'Integrity Patient', TENANT_ID);
    await insertUser(OTHER_PATIENT_UID, 'Integrity Other Patient', TENANT_ID);
    await insertUser(FOREIGN_PATIENT_UID, 'Integrity Foreign Patient', OTHER_TENANT_ID);
    await insertUser(TXN_PATIENT_UID, 'Integrity Txn Patient', TENANT_ID);
    admissionId = await insertAdmission(PATIENT_UID, TENANT_ID);
    otherPatientAdmissionId = await insertAdmission(OTHER_PATIENT_UID, TENANT_ID);
    foreignAdmissionId = await insertAdmission(FOREIGN_PATIENT_UID, OTHER_TENANT_ID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_templates (tenant_id, code, display_name, specialty, sections, active)
       VALUES ($1::uuid, $2, 'Integrity Template', 'general_medicine', $3::jsonb, true),
              ($1::uuid, $4, 'Integrity Dup-Section Template', 'general_medicine', $5::jsonb, true)`,
      TENANT_ID,
      TEMPLATE_CODE,
      JSON.stringify([
        { section_key: 'diagnosis', section_title: 'Diagnosis', display_order: 1, default_body: null },
        { section_key: 'discharge_medications', section_title: 'Discharge Medications', display_order: 2, default_body: null },
      ]),
      DUP_TEMPLATE_CODE,
      // Duplicate section_key → the second section INSERT violates the
      // (discharge_summary_id, section_key) unique index mid-create, which
      // must roll back the whole draft (A-L5).
      JSON.stringify([
        { section_key: 'diagnosis', section_title: 'Diagnosis', display_order: 1, default_body: null },
        { section_key: 'diagnosis', section_title: 'Diagnosis Again', display_order: 2, default_body: null },
      ]),
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── A-M4: createDraft admission validation ────────────────────────

  it('createDraft rejects a nonexistent admission_id with 404 ADMISSION_NOT_FOUND', async () => {
    const bogusAdmissionId = 2_100_000_000 + Math.floor(Math.random() * 40_000_000);
    await expect(dischargeService.createDraft({
      tenantId: TENANT_ID, patient_uid: PATIENT_UID,
      admission_id: bogusAdmissionId,
      template_code: TEMPLATE_CODE, created_by: SIGNER_UID,
    })).rejects.toMatchObject({ statusCode: 404, code: 'ADMISSION_NOT_FOUND' });
    expect(await summariesForPatient(PATIENT_UID)).toHaveLength(0);
  }, 30_000);

  it('createDraft rejects an admission belonging to another tenant with 404 ADMISSION_NOT_FOUND', async () => {
    await expect(dischargeService.createDraft({
      tenantId: TENANT_ID, patient_uid: PATIENT_UID,
      admission_id: foreignAdmissionId,
      template_code: TEMPLATE_CODE, created_by: SIGNER_UID,
    })).rejects.toMatchObject({ statusCode: 404, code: 'ADMISSION_NOT_FOUND' });
    expect(await summariesForPatient(PATIENT_UID)).toHaveLength(0);
  }, 30_000);

  it('createDraft rejects an admission belonging to a different patient with 400 mismatch', async () => {
    await expect(dischargeService.createDraft({
      tenantId: TENANT_ID, patient_uid: PATIENT_UID,
      admission_id: otherPatientAdmissionId,
      template_code: TEMPLATE_CODE, created_by: SIGNER_UID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'DISCHARGE_SUMMARY_ADMISSION_PATIENT_MISMATCH',
    });
    expect(await summariesForPatient(PATIENT_UID)).toHaveLength(0);
  }, 30_000);

  it('createDraft accepts the patient\'s own same-tenant admission', async () => {
    const draft = await dischargeService.createDraft({
      tenantId: TENANT_ID, patient_uid: PATIENT_UID,
      admission_id: admissionId,
      template_code: TEMPLATE_CODE, created_by: SIGNER_UID,
    });
    expect(Number(draft.admission_id)).toBe(admissionId);
    expect(draft.status).toBe('draft');
    linkedSummaryId = draft.id;
  }, 30_000);

  // ── A-L5: createDraft transactionality ────────────────────────────

  it('createDraft rolls back the header when a section insert fails (no signable partial summary)', async () => {
    await expect(dischargeService.createDraft({
      tenantId: TENANT_ID, patient_uid: TXN_PATIENT_UID,
      template_code: DUP_TEMPLATE_CODE, created_by: SIGNER_UID,
    })).rejects.toThrow();
    expect(await summariesForPatient(TXN_PATIENT_UID)).toHaveLength(0);
  }, 30_000);

  // ── A-M3: setSectionTranslation audit + canonical + status guard ──

  it('setSectionTranslation on a draft writes the translation with legacy audit + canonical pair', async () => {
    const draft = await dischargeService.createDraft({
      tenantId: TENANT_ID, patient_uid: PATIENT_UID,
      template_code: TEMPLATE_CODE, created_by: SIGNER_UID,
    });
    translationSummaryId = draft.id;

    const updated = await dischargeService.setSectionTranslation({
      tenantId: TENANT_ID, id: translationSummaryId, section_key: 'diagnosis',
      language: 'ta', body: 'நிமோனியா குணமடைந்தது', edited_by: SIGNER_UID,
    });
    const section = updated.sections.find((s) => s.section_key === 'diagnosis');
    expect(section.body_translations.ta).toBe('நிமோனியா குணமடைந்தது');

    const legacyAudit = await prisma.$queryRawUnsafe(
      `SELECT id FROM audit_logs
        WHERE action = 'DISCHARGE_SUMMARY_TRANSLATION_SET'
          AND resource = 'discharge_summary' AND resource_id = $1`,
      String(translationSummaryId),
    );
    expect(legacyAudit).toHaveLength(1);
    expect(await translationTimelineEvents()).toHaveLength(1);
    expect(await translationAuditEvents()).toHaveLength(1);
  }, 30_000);

  it('an exact translation retry is a no-op (no duplicate canonical events); an amended translation emits a new revision', async () => {
    await dischargeService.setSectionTranslation({
      tenantId: TENANT_ID, id: translationSummaryId, section_key: 'diagnosis',
      language: 'ta', body: 'நிமோனியா குணமடைந்தது', edited_by: SIGNER_UID,
    });
    expect(await translationTimelineEvents()).toHaveLength(1);
    expect(await translationAuditEvents()).toHaveLength(1);

    const amended = await dischargeService.setSectionTranslation({
      tenantId: TENANT_ID, id: translationSummaryId, section_key: 'diagnosis',
      language: 'ta', body: 'நிமோனியா முழுமையாக குணமடைந்தது', edited_by: SIGNER_UID,
    });
    const section = amended.sections.find((s) => s.section_key === 'diagnosis');
    expect(section.body_translations.ta).toBe('நிமோனியா முழுமையாக குணமடைந்தது');
    expect(await translationTimelineEvents()).toHaveLength(2);
    expect(await translationAuditEvents()).toHaveLength(2);
  }, 30_000);

  it('setSectionTranslation on a signed summary is rejected 409 and mutates nothing', async () => {
    await fillRequiredSections(translationSummaryId);
    const signed = await dischargeService.sign({
      tenantId: TENANT_ID, id: translationSummaryId,
      signed_by: SIGNER_UID, signed_by_name: 'Dr. Integrity', signed_by_reg: 'TN-99001',
    });
    expect(signed.status).toBe('signed');

    await expect(dischargeService.setSectionTranslation({
      tenantId: TENANT_ID, id: translationSummaryId, section_key: 'diagnosis',
      language: 'ta', body: 'தவறான மாற்றம்', edited_by: SIGNER_UID,
    })).rejects.toMatchObject({ statusCode: 409, code: 'DISCHARGE_SUMMARY_IMMUTABLE' });

    // The signed document's translation is untouched and no canonical event
    // was minted for the rejected mutation.
    const current = await dischargeService.getOne({ tenantId: TENANT_ID, id: translationSummaryId });
    const section = current.sections.find((s) => s.section_key === 'diagnosis');
    expect(section.body_translations.ta).toBe('நிமோனியா முழுமையாக குணமடைந்தது');
    expect(await translationTimelineEvents()).toHaveLength(2);
    expect(await translationAuditEvents()).toHaveLength(2);
  }, 30_000);

  // ── A-M4: sign() scoped admission stamp ───────────────────────────

  it('sign stamps summary_signed_at on the matching tenant+patient admission', async () => {
    await fillRequiredSections(linkedSummaryId);
    const signed = await dischargeService.sign({
      tenantId: TENANT_ID, id: linkedSummaryId,
      signed_by: SIGNER_UID, signed_by_name: 'Dr. Integrity', signed_by_reg: 'TN-99001',
    });
    expect(signed.status).toBe('signed');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT summary_signed_at FROM admissions WHERE id = $1::int`, admissionId,
    );
    expect(rows[0].summary_signed_at).not.toBeNull();
  }, 30_000);

  it('sign aborts (409, full rollback) when the summary\'s admission belongs to a different patient', async () => {
    // Simulate a legacy pre-validation row: a summary for PATIENT pointing at
    // OTHER_PATIENT's admission (createDraft now rejects this at create time).
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_summaries
         (admission_id, patient_uid, patient_name_snapshot, status, tenant_id)
       VALUES ($1::int, $2::uuid, 'Integrity Patient', 'draft', $3::uuid)
       RETURNING id`,
      otherPatientAdmissionId, PATIENT_UID, TENANT_ID,
    );
    const mismatchedSummaryId = Number(rows[0].id);

    await expect(dischargeService.sign({
      tenantId: TENANT_ID, id: mismatchedSummaryId,
      signed_by: SIGNER_UID, signed_by_name: 'Dr. Integrity', signed_by_reg: 'TN-99001',
    })).rejects.toMatchObject({ statusCode: 409, code: 'DISCHARGE_SUMMARY_ADMISSION_MISMATCH' });

    // Rollback: the status flip did not commit, and the wrong patient's
    // admission was never stamped — the discharge gate stays closed.
    const summaryRows = await prisma.$queryRawUnsafe(
      `SELECT status, signed_at FROM discharge_summaries WHERE id = $1::int`, mismatchedSummaryId,
    );
    expect(summaryRows[0].status).toBe('draft');
    expect(summaryRows[0].signed_at).toBeNull();
    const admissionRows = await prisma.$queryRawUnsafe(
      `SELECT summary_signed_at FROM admissions WHERE id = $1::int`, otherPatientAdmissionId,
    );
    expect(admissionRows[0].summary_signed_at).toBeNull();
  }, 30_000);
});
