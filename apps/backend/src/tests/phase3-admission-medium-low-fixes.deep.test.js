// Phase-3 Medium/Low fixes — admissionService, proven against a real DB:
//
//   A-M1: saveAdmissionCaseSheet (incl. allergy routing) persists the
//         canonical clinical_timeline_events + clinical_audit_events pair in
//         the SAME transaction as the detail write, on the amendable-record
//         fingerprint + :tx: idempotency keys, with an effective-state no-op
//         guard so an exact retry writes nothing.
//   A-L1: transferPatient enforces the day-care bed-pool match and relocates
//         active attendant passes to the target ward — the same gates
//         admitPatient / assignBedToAdmission already enforce.
//   A-L2: completeDischargeConsult holds a FOR UPDATE row lock and 409s a
//         double completion (DISCHARGE_CONSULT_STATE_CONFLICT) instead of
//         overwriting the winner's attribution/notes (PR #765 pattern).
//   A-L3: counter_consent_captured mints only a PROVISIONAL treatment
//         consent pre-tx; activation happens inside the admission
//         transaction, so a failed admission leaves no active consent.

import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const admissionService = (await import('../services/emr/admissionService.js')).default;
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const PATIENT_UID = randomUUID(); // case sheet + transfer relocation
const DC_PATIENT_UID = randomUUID(); // day-care pool checks
const CONSULT_PATIENT_UID = randomUUID(); // discharge-consult race
const CONSENT_PATIENT_UID = randomUUID(); // provisional-consent activation
const CONSENT2_PATIENT_UID = randomUUID(); // in-tx direct consent mint
const DOCTOR_UID = randomUUID();
const ADMIN_UID = randomUUID();
const WINNER_UID = randomUUID();
const LOSER_UID = randomUUID();

const WARD_1 = `P3ML-W1-${randomUUID().slice(0, 6)}`;
const WARD_2 = `P3ML-W2-${randomUUID().slice(0, 6)}`;

const BED_A = `P3ML-A-${randomUUID().slice(0, 6)}`; // general, ward 1 (initial admit)
const BED_B = `P3ML-B-${randomUUID().slice(0, 6)}`; // general, ward 2 (transfer target)
const BED_C = `P3ML-C-${randomUUID().slice(0, 6)}`; // general, ward 1 (day-care reject target)
const BED_DC1 = `P3ML-D1-${randomUUID().slice(0, 6)}`; // day_care, ward 1 (day-care admit)
const BED_DC2 = `P3ML-D2-${randomUUID().slice(0, 6)}`; // day_care, ward 1 (elective reject target)
const BED_BLOCKED = `P3ML-X-${randomUUID().slice(0, 6)}`; // general, ward 1, occupied
const BED_FREE_1 = `P3ML-F1-${randomUUID().slice(0, 6)}`; // general, ward 1
const BED_FREE_2 = `P3ML-F2-${randomUUID().slice(0, 6)}`; // general, ward 1

const ALL_PATIENT_UIDS = [
  PATIENT_UID, DC_PATIENT_UID, CONSULT_PATIENT_UID,
  CONSENT_PATIENT_UID, CONSENT2_PATIENT_UID,
];
const ALL_BED_NUMBERS = [BED_A, BED_B, BED_C, BED_DC1, BED_DC2, BED_BLOCKED, BED_FREE_1, BED_FREE_2];

let ward1Id;
let ward2Id;
const bedIds = {};

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function seedUser({ uid, role, name }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
    uid, phone(), name, role, DEFAULT_TENANT_ID,
  );
}

async function seedActiveTreatmentConsent(patientUid) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_consents (patient_uid, consent_type, granted, status, tenant_id)
     VALUES ($1::uuid, 'treatment', true, 'active', $2::uuid)`,
    patientUid, DEFAULT_TENANT_ID,
  );
}

async function timelineRows(patientUid, eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, source_id FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2`,
    patientUid, eventType,
  );
}

async function auditRows(patientUid, action) {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2`,
    patientUid, action,
  );
}

async function treatmentConsents(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, granted, granted_at, granted_by, notes
       FROM patient_consents
      WHERE patient_uid = $1::uuid AND consent_type = 'treatment'
      ORDER BY id`,
    patientUid,
  );
}

async function cleanup() {
  const ids = Object.values(bedIds).filter(Boolean).map(String);
  if (ids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE source_table = 'beds' AND source_id = ANY($1::text[])`,
      ids,
    ).catch(() => {});
    for (const id of ids) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM housekeeping_requests WHERE description LIKE '%bed_id=' || $1 || '.%'`,
        id,
      ).catch(() => {});
    }
  }
  for (const uid of ALL_PATIENT_UIDS) {
    await prisma.$executeRawUnsafe(`DELETE FROM attendant_passes WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM discharge_consults WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      uid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_encounters WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM beds WHERE bed_number = ANY($1::text[])`, ALL_BED_NUMBERS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name IN ($1, $2)`, WARD_1, WARD_2).catch(() => {});
  for (const uid of [...ALL_PATIENT_UIDS, DOCTOR_UID, ADMIN_UID]) {
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
  }
}

d('Phase-3 admission Medium/Low fixes (A-M1, A-L1, A-L2, A-L3)', () => {
  beforeAll(async () => {
    await seedUser({ uid: PATIENT_UID, role: 'PATIENT', name: 'P3ML Patient' });
    await seedUser({ uid: DC_PATIENT_UID, role: 'PATIENT', name: 'P3ML Day-care Patient' });
    await seedUser({ uid: CONSULT_PATIENT_UID, role: 'PATIENT', name: 'P3ML Consult Patient' });
    await seedUser({ uid: CONSENT_PATIENT_UID, role: 'PATIENT', name: 'P3ML Consent Patient' });
    await seedUser({ uid: CONSENT2_PATIENT_UID, role: 'PATIENT', name: 'P3ML Consent Patient 2' });
    await seedUser({ uid: DOCTOR_UID, role: 'DOCTOR', name: 'P3ML Doctor' });
    await seedUser({ uid: ADMIN_UID, role: 'ADMIN', name: 'P3ML Admin' });

    await seedActiveTreatmentConsent(PATIENT_UID);
    await seedActiveTreatmentConsent(DC_PATIENT_UID);

    const w1 = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 6) RETURNING id`,
      WARD_1,
    );
    ward1Id = w1[0].id;
    const w2 = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level)
       VALUES ($1, 2, 2, 'orange', 'enhanced') RETURNING id`,
      WARD_2,
    );
    ward2Id = w2[0].id;

    const mkBed = async (bedNumber, wardId, wardName, bedType, status = 'available') => {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6::uuid) RETURNING id`,
        wardId, wardName, bedNumber, bedType, status, DEFAULT_TENANT_ID,
      );
      return rows[0].id;
    };
    bedIds.a = await mkBed(BED_A, ward1Id, WARD_1, 'general');
    bedIds.b = await mkBed(BED_B, ward2Id, WARD_2, 'general');
    bedIds.c = await mkBed(BED_C, ward1Id, WARD_1, 'general');
    bedIds.dc1 = await mkBed(BED_DC1, ward1Id, WARD_1, 'day_care');
    bedIds.dc2 = await mkBed(BED_DC2, ward1Id, WARD_1, 'day_care');
    bedIds.blocked = await mkBed(BED_BLOCKED, ward1Id, WARD_1, 'general', 'occupied');
    bedIds.free1 = await mkBed(BED_FREE_1, ward1Id, WARD_1, 'general');
    bedIds.free2 = await mkBed(BED_FREE_2, ward1Id, WARD_1, 'general');
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  let admissionId; // PATIENT_UID's admission (bed A → transferred to bed B)
  let dcAdmissionId; // DC_PATIENT_UID's day-care admission (bed DC1)

  // ── A-M1: case-sheet save persists the canonical pair in the same tx ──────

  it('A-M1: creating the case sheet writes the detail row + one timeline + one audit event', async () => {
    const admission = await admissionService.admitPatient({
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      ward: WARD_1,
      bed_id: bedIds.a,
      chief_complaint: 'Initial complaint',
      admission_type: 'elective',
      created_by: ADMIN_UID,
      tenant_id: DEFAULT_TENANT_ID,
    });
    admissionId = admission.id;
    expect(admission.status).toBe('admitted');

    const result = await admissionService.saveAdmissionCaseSheet(
      admissionId,
      {
        chief_complaints: 'Chest pain on exertion',
        provisional_diagnosis: 'Suspected angina',
        allergies: 'Penicillin',
        vitals: { bp: '130/80' },
      },
      DOCTOR_UID,
      'DOCTOR',
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(result.action).toBe('created');
    expect(result.version).toBe(1);

    const timeline = await timelineRows(PATIENT_UID, 'admission.case_sheet_saved');
    expect(timeline).toHaveLength(1);
    expect(timeline[0].source_id).toBe(String(result.note_id));
    expect(await auditRows(PATIENT_UID, 'admission.case_sheet_saved')).toHaveLength(1);

    // Allergy routing to the admission row commits with the same pair.
    const adm = await prisma.$queryRawUnsafe(
      `SELECT allergies FROM admissions WHERE id = $1`, admissionId,
    );
    expect(adm[0].allergies).toEqual(['Penicillin']);
  }, 60_000);

  it('A-M1: an amendment emits a second canonical pair; an exact retry emits nothing and bumps nothing', async () => {
    const amended = await admissionService.saveAdmissionCaseSheet(
      admissionId,
      {
        chief_complaints: 'Chest pain on exertion, worse at night',
        provisional_diagnosis: 'Suspected angina',
        allergies: 'Penicillin',
        vitals: { bp: '130/80' },
      },
      DOCTOR_UID,
      'DOCTOR',
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(amended.action).toBe('updated');
    expect(amended.version).toBe(2);
    expect(await timelineRows(PATIENT_UID, 'admission.case_sheet_saved')).toHaveLength(2);
    expect(await auditRows(PATIENT_UID, 'admission.case_sheet_saved')).toHaveLength(2);

    // Exact retry of the same clinical content: no-op guard returns before
    // any write — same version, no third canonical revision.
    const retried = await admissionService.saveAdmissionCaseSheet(
      admissionId,
      {
        chief_complaints: 'Chest pain on exertion, worse at night',
        provisional_diagnosis: 'Suspected angina',
        allergies: 'Penicillin',
        vitals: { bp: '130/80' },
      },
      DOCTOR_UID,
      'DOCTOR',
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(retried.action).toBe('unchanged');
    expect(retried.version).toBe(2);
    expect(await timelineRows(PATIENT_UID, 'admission.case_sheet_saved')).toHaveLength(2);
    expect(await auditRows(PATIENT_UID, 'admission.case_sheet_saved')).toHaveLength(2);
  }, 60_000);

  // ── A-L1: transfer enforces the day-care bed-pool match ───────────────────

  it('A-L1: an elective admission cannot transfer into a day_care bed', async () => {
    await expect(
      admissionService.transferPatient(
        admissionId, null, bedIds.dc2, 'Pool mismatch test', ADMIN_UID,
        { tenantId: DEFAULT_TENANT_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // The rejected transfer changed nothing.
    const beds = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM beds WHERE id IN ($1, $2) ORDER BY id = $1 DESC`,
      bedIds.a, bedIds.dc2,
    );
    expect(beds.find((b) => b.id === bedIds.a).status).toBe('occupied');
    expect(beds.find((b) => b.id === bedIds.dc2).status).toBe('available');
  }, 60_000);

  it('A-L1: a day-care admission cannot transfer into a general bed', async () => {
    const dcAdmission = await admissionService.admitPatient({
      patient_uid: DC_PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      ward: WARD_1,
      bed_id: bedIds.dc1,
      chief_complaint: 'Day-care procedure',
      admission_type: 'day_care',
      created_by: ADMIN_UID,
      tenant_id: DEFAULT_TENANT_ID,
    });
    dcAdmissionId = dcAdmission.id;

    await expect(
      admissionService.transferPatient(
        dcAdmissionId, null, bedIds.c, 'Pool mismatch test', ADMIN_UID,
        { tenantId: DEFAULT_TENANT_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const dcAdm = await prisma.$queryRawUnsafe(
      `SELECT bed_id, status FROM admissions WHERE id = $1`, dcAdmissionId,
    );
    expect(dcAdm[0].bed_id).toBe(bedIds.dc1);
    expect(dcAdm[0].status).toBe('admitted');
  }, 60_000);

  // ── A-L1: transfer relocates active attendant passes to the new ward ──────

  it('A-L1: transferPatient re-stamps active attendant passes with the target ward', async () => {
    const passesBefore = await prisma.$queryRawUnsafe(
      `SELECT pass_index, ward_at_issue, status FROM attendant_passes
        WHERE admission_id = $1 ORDER BY pass_index`,
      admissionId,
    );
    expect(passesBefore).toHaveLength(2);
    expect(passesBefore.every((p) => p.ward_at_issue === WARD_1)).toBe(true);
    expect(passesBefore.every((p) => p.status === 'active')).toBe(true);

    const transferred = await admissionService.transferPatient(
      admissionId, null, bedIds.b, 'Relocation test', ADMIN_UID,
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(transferred.status).toBe('transferred');
    expect(transferred.bed_id).toBe(bedIds.b);

    const passesAfter = await prisma.$queryRawUnsafe(
      `SELECT pass_index, ward_at_issue, pass_color, screening_level FROM attendant_passes
        WHERE admission_id = $1 AND status = 'active' ORDER BY pass_index`,
      admissionId,
    );
    expect(passesAfter).toHaveLength(2);
    expect(passesAfter.every((p) => p.ward_at_issue === WARD_2)).toBe(true);
    expect(passesAfter.every((p) => p.pass_color === 'orange')).toBe(true);
    expect(passesAfter.every((p) => p.screening_level === 'enhanced')).toBe(true);
  }, 60_000);

  // ── A-L2: completeDischargeConsult double-completion race ────────────────

  it('A-L2: a racing double completion 409s and preserves the winner attribution and notes', async () => {
    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), NOW()) RETURNING id`,
      DEFAULT_TENANT_ID, CONSULT_PATIENT_UID,
    );
    const consultAdmissionId = admissionRows[0].id;
    const consultRows = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_consults
         (tenant_id, admission_id, patient_uid, consult_type, requested_at, requested_by)
       VALUES ($1::uuid, $2, $3::uuid, 'family_counselling', NOW(), $4::uuid)
       RETURNING id`,
      DEFAULT_TENANT_ID, consultAdmissionId, CONSULT_PATIENT_UID, DOCTOR_UID,
    );
    const consultId = consultRows[0].id;

    const lockHeld = deferred();
    const releaseLock = deferred();
    const winner = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM discharge_consults WHERE id = $1 FOR UPDATE`,
        consultId,
      );
      lockHeld.resolve();
      await releaseLock.promise;
      await tx.$executeRawUnsafe(
        `UPDATE discharge_consults
            SET completed_at = NOW(), completed_by = $2::uuid, notes = $3, updated_at = NOW()
          WHERE id = $1`,
        consultId, WINNER_UID, 'winner notes',
      );
    }, { timeout: 30_000, maxWait: 10_000 });

    await lockHeld.promise;

    // Loser passes Phase-0 (row not completed, read unlocked), then blocks on
    // the in-tx FOR UPDATE held by the winner.
    const loser = admissionService.completeDischargeConsult(
      consultAdmissionId, 'family_counselling', LOSER_UID, 'loser notes',
      { tenantId: DEFAULT_TENANT_ID },
    );
    loser.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 750));
    releaseLock.resolve();
    await winner;

    await expect(loser).rejects.toMatchObject({
      statusCode: 409,
      code: 'DISCHARGE_CONSULT_STATE_CONFLICT',
    });

    const row = await prisma.$queryRawUnsafe(
      `SELECT completed_by::text, notes FROM discharge_consults WHERE id = $1`,
      consultId,
    );
    expect(row[0].completed_by).toBe(WINNER_UID);
    expect(row[0].notes).toBe('winner notes');

    // The rejected completion emitted no canonical event for this consult.
    const timeline = await timelineRows(CONSULT_PATIENT_UID, 'discharge.work_item_completed');
    expect(timeline.filter((t) => t.source_id === String(consultId))).toHaveLength(0);
  }, 60_000);

  it('A-L2: an uncontended completion succeeds with the canonical pair; a repeat call returns the winner idempotently', async () => {
    const admissionRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status = 'admitted'`,
      CONSULT_PATIENT_UID,
    );
    const consultAdmissionId = admissionRows[0].id;
    const consultRows = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_consults
         (tenant_id, admission_id, patient_uid, consult_type, requested_at, requested_by)
       VALUES ($1::uuid, $2, $3::uuid, 'physiotherapy', NOW(), $4::uuid)
       RETURNING id`,
      DEFAULT_TENANT_ID, consultAdmissionId, CONSULT_PATIENT_UID, DOCTOR_UID,
    );
    const consultId = consultRows[0].id;

    const completed = await admissionService.completeDischargeConsult(
      consultAdmissionId, 'physiotherapy', WINNER_UID, 'physio done',
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(String(completed.completed_by)).toBe(WINNER_UID);
    expect(completed.notes).toBe('physio done');
    expect(completed.completed_at).not.toBeNull();

    const timeline = await timelineRows(CONSULT_PATIENT_UID, 'discharge.work_item_completed');
    expect(timeline.filter((t) => t.source_id === String(consultId))).toHaveLength(1);
    expect(await auditRows(CONSULT_PATIENT_UID, 'discharge.work_item_completed')).toHaveLength(1);

    // Sequential repeat (no race): Phase-0 short-circuit stays idempotent —
    // returns the completed row without touching attribution or notes.
    const repeat = await admissionService.completeDischargeConsult(
      consultAdmissionId, 'physiotherapy', LOSER_UID, 'late duplicate',
      { tenantId: DEFAULT_TENANT_ID },
    );
    expect(String(repeat.completed_by)).toBe(WINNER_UID);
    expect(repeat.notes).toBe('physio done');
  }, 60_000);

  // ── A-L3: counter consent is provisional until the admission commits ──────

  it('A-L3: ensureCounterTreatmentConsent mints a provisional (not active) consent', async () => {
    const [held, raced] = await Promise.all([
      admissionService.ensureCounterTreatmentConsent({
        patientUid: CONSENT_PATIENT_UID,
        grantedBy: ADMIN_UID,
        tenantId: DEFAULT_TENANT_ID,
      }),
      admissionService.ensureCounterTreatmentConsent({
        patientUid: CONSENT_PATIENT_UID,
        grantedBy: ADMIN_UID,
        tenantId: DEFAULT_TENANT_ID,
      }),
    ]);
    expect(held?.id).toBeTruthy();
    expect(raced.id).toBe(held.id);

    const rows = await treatmentConsents(CONSENT_PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('provisional');
    expect(rows[0].granted).toBe(false);
    expect(rows[0].granted_at).toBeNull();

    // Idempotent: a repeat capture reuses the same provisional hold.
    const again = await admissionService.ensureCounterTreatmentConsent({
      patientUid: CONSENT_PATIENT_UID,
      grantedBy: ADMIN_UID,
      tenantId: DEFAULT_TENANT_ID,
    });
    expect(again.id).toBe(held.id);
    expect(await treatmentConsents(CONSENT_PATIENT_UID)).toHaveLength(1);
  }, 30_000);

  it('A-L3: a failed admission leaves no active consent behind', async () => {
    // BED_BLOCKED is occupied — the in-tx bed availability check throws after
    // the consent activation point, so the whole transaction rolls back.
    const [held] = await treatmentConsents(CONSENT_PATIENT_UID);
    await expect(
      admissionService.admitPatient({
        patient_uid: CONSENT_PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        ward: WARD_1,
        bed_id: bedIds.blocked,
        chief_complaint: 'Failed admit fixture',
        admission_type: 'elective',
        created_by: ADMIN_UID,
        tenant_id: DEFAULT_TENANT_ID,
        counter_consent_captured: true,
        counter_treatment_consent_id: held.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const rows = await treatmentConsents(CONSENT_PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('provisional');
    expect(rows[0].granted).toBe(false);
    expect(rows[0].granted_at).toBeNull();
    expect(await timelineRows(CONSENT_PATIENT_UID, 'consent.granted')).toHaveLength(0);
  }, 60_000);

  it('A-L3: a successful admission activates the provisional consent atomically with the canonical pair', async () => {
    const before = await treatmentConsents(CONSENT_PATIENT_UID);
    const provisionalId = before[0].id;
    const staleDuplicate = await prisma.patient_consents.create({
      data: {
        patient_uid: CONSENT_PATIENT_UID,
        tenant_id: DEFAULT_TENANT_ID,
        consent_type: 'treatment',
        granted: false,
        status: 'provisional',
        granted_by: ADMIN_UID,
        notes: 'Legacy duplicate provisional fixture',
      },
      select: { id: true },
    });

    const admission = await admissionService.admitPatient({
      patient_uid: CONSENT_PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      ward: WARD_1,
      bed_id: bedIds.free1,
      chief_complaint: 'Successful admit fixture',
      admission_type: 'elective',
      created_by: ADMIN_UID,
      tenant_id: DEFAULT_TENANT_ID,
      counter_consent_captured: true,
      counter_treatment_consent_id: provisionalId,
    });
    expect(admission.status).toBe('admitted');

    const rows = await treatmentConsents(CONSENT_PATIENT_UID);
    expect(rows).toHaveLength(2);
    const activated = rows.find((row) => row.id === provisionalId);
    const untouched = rows.find((row) => row.id === staleDuplicate.id);
    expect(activated?.status).toBe('active');
    expect(activated?.granted).toBe(true);
    expect(activated?.granted_at).not.toBeNull();
    expect(untouched?.status).toBe('provisional');
    expect(untouched?.granted).toBe(false);
    expect(untouched?.granted_at).toBeNull();

    expect(await timelineRows(CONSENT_PATIENT_UID, 'consent.granted')).toHaveLength(1);
    expect(await auditRows(CONSENT_PATIENT_UID, 'consent.granted')).toHaveLength(1);
  }, 60_000);

  it('A-L3: counter capture without a pre-flight hold mints the active consent inside the admission tx', async () => {
    expect(await treatmentConsents(CONSENT2_PATIENT_UID)).toHaveLength(0);

    const admission = await admissionService.admitPatient({
      patient_uid: CONSENT2_PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      ward: WARD_1,
      bed_id: bedIds.free2,
      chief_complaint: 'Direct counter-consent admit',
      admission_type: 'elective',
      created_by: ADMIN_UID,
      tenant_id: DEFAULT_TENANT_ID,
      counter_consent_captured: true,
    });
    expect(admission.status).toBe('admitted');

    const rows = await treatmentConsents(CONSENT2_PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].granted).toBe(true);
    expect(rows[0].notes).toBe('Captured at reception admission counter');
    expect(await timelineRows(CONSENT2_PATIENT_UID, 'consent.granted')).toHaveLength(1);
    expect(await auditRows(CONSENT2_PATIENT_UID, 'consent.granted')).toHaveLength(1);
  }, 60_000);
});
