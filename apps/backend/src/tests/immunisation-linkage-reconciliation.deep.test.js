// immunisation-linkage-reconciliation.deep.test.js
//
// O1 — exact, unambiguous newborn↔patient immunisation identity linkage
// and the read-only tenant-scoped reconciliation report.
//
// Covers the mandated cases and coordinator regressions:
//   1. exact link                 — one newborn + one matching newborn dose → back-link written
//   2. no match                   — walk-in patient (no newborn) → unlinked, normal seed
//   3. multiple newborns          — >1 newborn for the uid → refuse link, reported
//   4. multiple dose candidates   — >1 matching newborn dose for the uid → refuse link, reported
//   5. tenant isolation           — a newborn dose in tenant A never links a seed in tenant B
//   6. idempotent repeat seed     — re-seeding does not duplicate or re-link; report is stable
//   7. deduped read               — a linked dose is projected once with authoritative newborn facts
//   8. administered-history       — a 'given' newborn dose is never mutated/merged/copied by linkage
//   9. stale link                 — a wrong/no-candidate link cannot hide patient history
//  10. later ambiguity            — a once-exact link is no longer trusted after identity becomes ambiguous
// The unit suite additionally proves the resolution/write race is closed by
// exactness locks followed by one tenant-transaction INSERT...SELECT.
//
// All fixtures are built with raw SQL against the disposable test DB and the
// service functions are exercised directly (the import deep-test does the same),
// so the assertions are deterministic and hermetic to the two test tenants.

import prisma from '../lib/prisma.js';
import {
  seedScheduleForPatient,
  listForPatient,
  listDueForPatient,
} from '../services/paediatric/paediatricImmunisationService.js';
import { buildLinkageReport } from '../../scripts/immunisation-linkage-report.mjs';

const TENANT_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a101';
const TENANT_B = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b202';
const TEST_TIMEOUT_MS = 30000;

// Deterministic patient uids per scenario (all live in TENANT_A unless noted).
const P_EXACT = 'a1a1a1a1-0000-4000-8000-000000000001';
const P_WALKIN = 'a1a1a1a1-0000-4000-8000-000000000002';
const P_MULTI_NB = 'a1a1a1a1-0000-4000-8000-000000000003';
const P_MULTI_DOSE = 'a1a1a1a1-0000-4000-8000-000000000004';
const P_GIVEN = 'a1a1a1a1-0000-4000-8000-000000000005';
const P_IDEMPOTENT = 'a1a1a1a1-0000-4000-8000-000000000006';
const P_STALE = 'a1a1a1a1-0000-4000-8000-000000000007';
const P_AMBIGUOUS_AFTER_LINK = 'a1a1a1a1-0000-4000-8000-000000000008';
const P_OTHER_IDENTITY = 'a1a1a1a1-0000-4000-8000-000000000009';
const P_RACE = 'a1a1a1a1-0000-4000-8000-000000000010';
const P_BAD_CATALOGUE = 'a1a1a1a1-0000-4000-8000-000000000011';
// Cross-tenant: the users row lives in TENANT_B, the (leaky) newborn in TENANT_A.
const P_ISO = 'b2b2b2b2-0000-4000-8000-000000000001';

let phoneSeq = 900009500;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

function dobYearsAgo(years) {
  return new Date(Date.now() - years * 365 * 86400000).toISOString().slice(0, 10);
}

async function ensureTenant(tenantId, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name`,
    tenantId, slug, `O1 ${slug}`,
  );
}

async function insertPatient(tenantId, uid, dob) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, birthday, gender, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'O1 Immun Child', 'PATIENT', $3::date, 'Male', true, $4::uuid, NOW())
     ON CONFLICT (uid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, birthday = EXCLUDED.birthday`,
    uid, nextPhone(), dob, tenantId,
  );
}

/**
 * Insert a catalogue vaccine for a tenant and return its id.
 * Codes are unique per (tenant, code, dose_number).
 */
async function insertCatalogue(tenantId, { code, dose, ageDays, source = 'uip', version = 'test-v1' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO vaccine_catalogue
       (code, display_name, dose_number, recommended_age_days, window_days,
        active, schedule_source, source_version, tenant_id)
     VALUES ($1, $2, $3, $4, 28, true, $5, $6, $7::uuid)
     RETURNING id`,
    code, `${code} ${dose ?? ''}`.trim(), dose ?? null, ageDays, source, version, tenantId,
  );
  return Number(rows[0].id);
}

async function insertDelivery(tenantId, { birthIso = '2022-01-01T04:00:00Z' } = {}) {
  const preg = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies (patient_uid, tenant_id)
     VALUES ($1::uuid, $2::uuid) RETURNING id`,
    // mother uid is arbitrary (no FK); derive a stable-ish uuid from the baby
    '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c', tenantId,
  );
  const delivery = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries (pregnancy_id, delivery_datetime, delivery_mode, tenant_id)
     VALUES ($1::int, $2::timestamptz, 'nvd', $3::uuid) RETURNING id`,
    Number(preg[0].id), birthIso, tenantId,
  );
  return Number(delivery[0].id);
}

/**
 * Build a maternity newborn (pregnancy → delivery → newborn) and return its id.
 * The newborn is linked to `babyUid` via newborn_patient_uid unless null.
 */
async function insertNewborn(tenantId, babyUid, { birthIso = '2022-01-01T04:00:00Z' } = {}) {
  const deliveryId = await insertDelivery(tenantId, { birthIso });
  const newborn = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_datetime, outcome, newborn_patient_uid, tenant_id)
     VALUES ($1::int, $2::timestamptz, 'live', $3, $4::uuid) RETURNING id`,
    deliveryId, birthIso, babyUid /* may be null */, tenantId,
  );
  return Number(newborn[0].id);
}

async function insertNewbornDose(tenantId, newbornId, vaccineCatalogueId, {
  status = 'scheduled', givenAt = null, dueDate = '2022-01-01',
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO newborn_immunisations
       (newborn_id, vaccine_catalogue_id, due_date, status, given_at, tenant_id)
     VALUES ($1::int, $2::int, $3::date, $4, $5::timestamptz, $6::uuid)
     RETURNING id`,
    newbornId, vaccineCatalogueId, dueDate, status, givenAt, tenantId,
  );
  return Number(rows[0].id);
}

async function patientRows(tenantId, patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT pi.id, pi.vaccine_catalogue_id, pi.status, pi.newborn_immunisation_id,
            vc.code
       FROM patient_immunisations pi
       JOIN vaccine_catalogue vc ON vc.id = pi.vaccine_catalogue_id
      WHERE pi.tenant_id = $1::uuid AND pi.patient_uid = $2::uuid
      ORDER BY vc.code`,
    tenantId, patientUid,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRaceMarker(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT pg_try_advisory_xact_lock(7010101::bigint) AS acquired',
    );
    if (rows[0]?.acquired === false) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for the O1 seed race marker');
}

async function cleanupTenant(tenantId) {
  // FK-safe order.
  for (const sql of [
    `DELETE FROM newborn_immunisations WHERE tenant_id = $1::uuid`,
    `DELETE FROM patient_immunisations WHERE tenant_id = $1::uuid`,
    `DELETE FROM maternity_newborns WHERE tenant_id = $1::uuid`,
    `DELETE FROM maternity_deliveries WHERE tenant_id = $1::uuid`,
    `DELETE FROM maternity_pregnancies WHERE tenant_id = $1::uuid`,
    `DELETE FROM vaccine_catalogue WHERE tenant_id = $1::uuid`,
    `DELETE FROM users WHERE tenant_id = $1::uuid`,
  ]) {
    await prisma.$executeRawUnsafe(sql, tenantId).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId).catch(() => {});
}

// Per-tenant catalogue ids, resolved in beforeAll.
const cat = { a: {}, b: {} };

describe('O1 exact immunisation linkage + reconciliation report', () => {
  beforeAll(async () => {
    await cleanupTenant(TENANT_A);
    await cleanupTenant(TENANT_B);
    await ensureTenant(TENANT_A, 'o1-tenant-a');
    await ensureTenant(TENANT_B, 'o1-tenant-b');

    // Small deterministic catalogue per tenant: BCG (birth), HEPB1 (6w), OPV1 (6w).
    cat.a.BCG = await insertCatalogue(TENANT_A, { code: 'BCG', dose: null, ageDays: 0 });
    cat.a.HEPB = await insertCatalogue(TENANT_A, { code: 'HEPB', dose: 1, ageDays: 42 });
    cat.a.OPV = await insertCatalogue(TENANT_A, { code: 'OPV', dose: 1, ageDays: 42 });
    cat.b.BCG = await insertCatalogue(TENANT_B, { code: 'BCG', dose: null, ageDays: 0 });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await cleanupTenant(TENANT_A);
    await cleanupTenant(TENANT_B);
    await prisma.$disconnect().catch(() => {});
  }, TEST_TIMEOUT_MS);

  it('1. writes the exact back-link when exactly one newborn + one matching dose exist', async () => {
    await insertPatient(TENANT_A, P_EXACT, dobYearsAgo(2));
    const newbornId = await insertNewborn(TENANT_A, P_EXACT);
    const doseId = await insertNewbornDose(TENANT_A, newbornId, cat.a.BCG, {
      status: 'given',
      givenAt: '2022-01-02T05:00:00.000Z',
    });

    await seedScheduleForPatient({ patientUid: P_EXACT, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const rows = await patientRows(TENANT_A, P_EXACT);
    const bcg = rows.find((r) => r.code === 'BCG');
    const hepb = rows.find((r) => r.code === 'HEPB');
    expect(bcg.newborn_immunisation_id).toBe(doseId);
    expect(bcg.status).toBe('scheduled');
    // Vaccines with no matching newborn dose stay unlinked.
    expect(hepb.newborn_immunisation_id).toBeNull();

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const exact = report.records.find(
      (record) => record.patient_uid === P_EXACT && record.code === 'BCG',
    );
    expect(exact).toMatchObject({
      kind: 'patient_dose',
      reason: 'already_linked',
      patient_uid: P_EXACT,
      vaccine_catalogue_id: cat.a.BCG,
      code: 'BCG',
      dose_number: null,
      display_name: 'BCG',
      schedule_source: 'uip',
      source_version: 'test-v1',
      patient_status: 'scheduled',
      current_link: doseId,
      newborn_count: 1,
      newborn_dose_count: 1,
      newborn_id: newbornId,
      newborn_patient_uid: P_EXACT,
      newborn_immunisation_id: doseId,
      newborn_due_date: '2022-01-01',
      newborn_status: 'given',
      newborn_given_at: '2022-01-02T05:00:00.000Z',
    });
    expect(exact.patient_immunisation_id).toBeGreaterThan(0);
    expect(exact.patient_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(exact.patient_given_at).toBeNull();
    expect(exact.candidate_newborn_ids).toEqual([newbornId]);
    expect(exact.candidate_newborn_immunisation_ids).toEqual([doseId]);
    expect(exact.candidate_doses).toEqual([{
      newborn_id: newbornId,
      newborn_immunisation_id: doseId,
      newborn_due_date: '2022-01-01',
      newborn_status: 'given',
      newborn_given_at: '2022-01-02T05:00:00.000Z',
    }]);

    const noDose = report.records.find(
      (record) => record.patient_uid === P_EXACT && record.code === 'HEPB',
    );
    expect(noDose).toMatchObject({
      kind: 'patient_dose',
      reason: 'no_matching_dose',
      patient_uid: P_EXACT,
      vaccine_catalogue_id: cat.a.HEPB,
      code: 'HEPB',
      dose_number: 1,
      schedule_source: 'uip',
      source_version: 'test-v1',
      patient_status: 'scheduled',
      current_link: null,
      newborn_count: 1,
      newborn_dose_count: 0,
      newborn_patient_uid: P_EXACT,
    });
    expect(noDose.patient_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(noDose.candidate_newborn_ids).toEqual([newbornId]);
    expect(noDose.candidate_newborn_immunisation_ids).toEqual([]);
    expect(noDose.candidate_doses).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('2. leaves every dose unlinked for a walk-in patient with no newborn', async () => {
    await insertPatient(TENANT_A, P_WALKIN, dobYearsAgo(2));
    await seedScheduleForPatient({ patientUid: P_WALKIN, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const rows = await patientRows(TENANT_A, P_WALKIN);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.newborn_immunisation_id === null)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('2b. reports a dose whose newborn has no patient uid with complete evidence', async () => {
    const newbornId = await insertNewborn(TENANT_A, null);
    const doseId = await insertNewbornDose(TENANT_A, newbornId, cat.a.BCG, {
      status: 'given',
      givenAt: '2022-02-03T05:00:00.000Z',
      dueDate: '2022-02-02',
    });

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const orphan = report.records.find(
      (record) => record.kind === 'newborn_dose'
        && record.newborn_immunisation_id === doseId,
    );
    expect(orphan).toMatchObject({
      kind: 'newborn_dose',
      reason: 'missing_newborn_patient_uid',
      patient_uid: null,
      patient_immunisation_id: null,
      vaccine_catalogue_id: cat.a.BCG,
      code: 'BCG',
      dose_number: null,
      display_name: 'BCG',
      schedule_source: 'uip',
      source_version: 'test-v1',
      patient_due_date: null,
      patient_status: null,
      patient_given_at: null,
      current_link: null,
      newborn_count: 1,
      newborn_dose_count: 1,
      newborn_id: newbornId,
      newborn_patient_uid: null,
      newborn_immunisation_id: doseId,
      newborn_due_date: '2022-02-02',
      newborn_status: 'given',
      newborn_given_at: '2022-02-03T05:00:00.000Z',
    });
    expect(orphan.candidate_newborn_ids).toEqual([newbornId]);
    expect(orphan.candidate_newborn_immunisation_ids).toEqual([doseId]);
    expect(orphan.candidate_doses).toEqual([{
      newborn_id: newbornId,
      newborn_immunisation_id: doseId,
      newborn_due_date: '2022-02-02',
      newborn_status: 'given',
      newborn_given_at: '2022-02-03T05:00:00.000Z',
    }]);
  }, TEST_TIMEOUT_MS);

  it('3. refuses to link when the uid maps to multiple newborns', async () => {
    await insertPatient(TENANT_A, P_MULTI_NB, dobYearsAgo(2));
    const nb1 = await insertNewborn(TENANT_A, P_MULTI_NB);
    const nb2 = await insertNewborn(TENANT_A, P_MULTI_NB);
    await insertNewbornDose(TENANT_A, nb1, cat.a.BCG);
    // nb2 has no BCG dose — still ambiguous identity, so nothing links.

    await seedScheduleForPatient({ patientUid: P_MULTI_NB, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const rows = await patientRows(TENANT_A, P_MULTI_NB);
    expect(rows.every((r) => r.newborn_immunisation_id === null)).toBe(true);

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const rec = report.records.find(
      (x) => x.patient_uid === P_MULTI_NB && x.code === 'BCG',
    );
    expect(rec).toBeTruthy();
    expect(rec.reason).toBe('multiple_newborns');
    expect(rec.newborn_count).toBe(2);
    expect(rec.newborn_dose_count).toBe(1);
    expect(rec.current_link).toBeNull();
    expect(rec).toMatchObject({
      vaccine_catalogue_id: cat.a.BCG,
      code: 'BCG',
      dose_number: null,
      schedule_source: 'uip',
      source_version: 'test-v1',
      patient_status: 'scheduled',
      newborn_id: null,
      newborn_immunisation_id: null,
      newborn_due_date: null,
      newborn_status: null,
      newborn_given_at: null,
    });
    expect(rec.patient_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rec.candidate_newborn_ids).toEqual([nb1, nb2].sort((a, b) => a - b));
    expect(rec.candidate_newborn_immunisation_ids).toHaveLength(1);
    expect(rec.candidate_doses).toEqual([{
      newborn_id: nb1,
      newborn_immunisation_id: rec.candidate_newborn_immunisation_ids[0],
      newborn_due_date: '2022-01-01',
      newborn_status: 'scheduled',
      newborn_given_at: null,
    }]);
  }, TEST_TIMEOUT_MS);

  it('4. refuses to link and reports multiple matching dose candidates', async () => {
    await insertPatient(TENANT_A, P_MULTI_DOSE, dobYearsAgo(2));
    const nb1 = await insertNewborn(TENANT_A, P_MULTI_DOSE);
    const nb2 = await insertNewborn(TENANT_A, P_MULTI_DOSE);
    await insertNewbornDose(TENANT_A, nb1, cat.a.BCG);
    await insertNewbornDose(TENANT_A, nb2, cat.a.BCG); // second candidate for same vaccine

    await seedScheduleForPatient({ patientUid: P_MULTI_DOSE, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const rows = await patientRows(TENANT_A, P_MULTI_DOSE);
    const bcg = rows.find((r) => r.code === 'BCG');
    expect(bcg.newborn_immunisation_id).toBeNull();

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const rec = report.records.find(
      (x) => x.patient_uid === P_MULTI_DOSE && x.code === 'BCG',
    );
    expect(rec).toBeTruthy();
    // Two matching newborn doses are a deterministic dose ambiguity, even
    // though they necessarily belong to two newborn identity candidates.
    expect(rec.newborn_dose_count).toBe(2);
    expect(rec.reason).toBe('multiple_doses');
    expect(rec.newborn_count).toBe(2);
    expect(rec.current_link).toBeNull();
    expect(rec).toMatchObject({
      vaccine_catalogue_id: cat.a.BCG,
      code: 'BCG',
      schedule_source: 'uip',
      source_version: 'test-v1',
      patient_status: 'scheduled',
      newborn_id: null,
      newborn_immunisation_id: null,
      newborn_due_date: null,
      newborn_status: null,
    });
    expect(rec.candidate_newborn_ids).toEqual([nb1, nb2].sort((a, b) => a - b));
    expect(rec.candidate_newborn_immunisation_ids).toHaveLength(2);
    expect(rec.candidate_doses).toHaveLength(2);
    expect(rec.candidate_doses.every((candidate) => (
      candidate.newborn_due_date === '2022-01-01'
      && candidate.newborn_status === 'scheduled'
      && candidate.newborn_given_at === null
    ))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('5. never links across tenants (dose in A, patient seed in B)', async () => {
    // Patient lives in tenant B; a newborn in tenant A leakily references the same uid.
    await insertPatient(TENANT_B, P_ISO, dobYearsAgo(2));
    const leakyNewborn = await insertNewborn(TENANT_A, P_ISO);
    await insertNewbornDose(TENANT_A, leakyNewborn, cat.a.BCG);

    await seedScheduleForPatient({ patientUid: P_ISO, dob: dobYearsAgo(2), tenantId: TENANT_B });

    const rows = await patientRows(TENANT_B, P_ISO);
    const bcg = rows.find((r) => r.code === 'BCG');
    expect(bcg.newborn_immunisation_id).toBeNull();

    // The tenant-B report includes its own patient row, but must not surface or
    // dereference tenant-A's newborn/dose.
    const reportB = await buildLinkageReport({ tenantId: TENANT_B });
    const rec = reportB.records.find((x) => x.patient_uid === P_ISO && x.code === 'BCG');
    expect(rec.reason).toBe('no_newborn_match');
    expect(rec.newborn_count).toBe(0);
    expect(rec.current_link).toBeNull();
    expect(rec.candidate_newborn_ids).toEqual([]);
    expect(rec.candidate_newborn_immunisation_ids).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('5b. reports a cross-tenant catalogue reference without dereferencing it', async () => {
    await insertPatient(TENANT_A, P_BAD_CATALOGUE, dobYearsAgo(2));
    const foreignNewborn = await insertNewborn(TENANT_B, P_BAD_CATALOGUE);
    const foreignDose = await insertNewbornDose(
      TENANT_B,
      foreignNewborn,
      cat.b.BCG,
      { status: 'given', givenAt: '2022-03-02T05:00:00.000Z' },
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_immunisations
         (patient_uid, vaccine_catalogue_id, due_date, status,
          newborn_immunisation_id, tenant_id)
       VALUES ($1::uuid, $2::int, '2022-01-01'::date, 'scheduled',
               $3::int, $4::uuid)`,
      P_BAD_CATALOGUE, cat.b.BCG, foreignDose, TENANT_A,
    );

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const rec = report.records.find(
      (record) => record.patient_uid === P_BAD_CATALOGUE,
    );
    expect(rec).toMatchObject({
      reason: 'catalogue_tenant_mismatch',
      patient_uid: P_BAD_CATALOGUE,
      vaccine_catalogue_id: cat.b.BCG,
      code: null,
      display_name: null,
      schedule_source: null,
      source_version: null,
      current_link: foreignDose,
      newborn_count: 0,
      newborn_dose_count: 0,
      newborn_id: null,
      newborn_immunisation_id: null,
      newborn_status: null,
    });
    expect(rec.candidate_newborn_ids).toEqual([]);
    expect(rec.candidate_newborn_immunisation_ids).toEqual([]);
    expect(rec.candidate_doses).toEqual([]);
    expect(report.records.some((record) => (
      record.newborn_id === foreignNewborn
      || record.newborn_immunisation_id === foreignDose
    ))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('6. is idempotent across repeat seeds and produces a stable report', async () => {
    await insertPatient(TENANT_A, P_IDEMPOTENT, dobYearsAgo(2));
    const newbornId = await insertNewborn(TENANT_A, P_IDEMPOTENT);
    const doseId = await insertNewbornDose(TENANT_A, newbornId, cat.a.BCG);

    await seedScheduleForPatient({ patientUid: P_IDEMPOTENT, dob: dobYearsAgo(2), tenantId: TENANT_A });
    const first = await patientRows(TENANT_A, P_IDEMPOTENT);
    const report1 = await buildLinkageReport({ tenantId: TENANT_A });

    await seedScheduleForPatient({ patientUid: P_IDEMPOTENT, dob: dobYearsAgo(2), tenantId: TENANT_A });
    const second = await patientRows(TENANT_A, P_IDEMPOTENT);
    const report2 = await buildLinkageReport({ tenantId: TENANT_A });

    // No duplicate rows, link unchanged.
    expect(second.length).toBe(first.length);
    const bcg = second.find((r) => r.code === 'BCG');
    expect(bcg.newborn_immunisation_id).toBe(doseId);
    // Deterministic report — identical across runs.
    expect(report2.records).toEqual(report1.records);
  }, TEST_TIMEOUT_MS);

  it('7. deduped read: an exactly linked GIVEN dose is returned once with authoritative newborn facts', async () => {
    // P_EXACT (from test 1) has a linked GIVEN newborn BCG row while the
    // patient row intentionally remains scheduled.
    const full = await listForPatient(P_EXACT, { tenantId: TENANT_A });
    const bcgRows = full.filter((r) => r.code === 'BCG');
    expect(bcgRows).toHaveLength(1);
    expect(bcgRows[0].status).toBe('given');
    expect(new Date(bcgRows[0].given_at).toISOString()).toBe('2022-01-02T05:00:00.000Z');
    expect(full.some((r) => r.code === 'HEPB')).toBe(true);

    const due = await listDueForPatient(P_EXACT, { tenantId: TENANT_A });
    // GIVEN is not due, but it remains visible in the full staff history above.
    expect(due.some((r) => r.code === 'BCG')).toBe(false);
    expect(due.some((r) => r.code === 'HEPB')).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('8. preserves administered history: a given newborn dose is never mutated or copied', async () => {
    await insertPatient(TENANT_A, P_GIVEN, dobYearsAgo(2));
    const newbornId = await insertNewborn(TENANT_A, P_GIVEN);
    const givenAt = '2022-01-02T05:00:00.000Z';
    const doseId = await insertNewbornDose(TENANT_A, newbornId, cat.a.BCG, {
      status: 'given', givenAt,
    });

    const before = await prisma.$queryRawUnsafe(
      `SELECT status, given_at FROM newborn_immunisations WHERE id = $1::int`,
      doseId,
    );

    await seedScheduleForPatient({ patientUid: P_GIVEN, dob: dobYearsAgo(2), tenantId: TENANT_A });
    await buildLinkageReport({ tenantId: TENANT_A });

    const after = await prisma.$queryRawUnsafe(
      `SELECT status, given_at FROM newborn_immunisations WHERE id = $1::int`,
      doseId,
    );
    // Newborn 'given' history untouched by linkage + report.
    expect(after[0].status).toBe('given');
    expect(new Date(after[0].given_at).toISOString()).toBe(new Date(before[0].given_at).toISOString());

    // Patient row is linked but its own status is NOT copied from the newborn dose.
    const rows = await patientRows(TENANT_A, P_GIVEN);
    const bcg = rows.find((r) => r.code === 'BCG');
    expect(bcg.newborn_immunisation_id).toBe(doseId);
    expect(bcg.status).toBe('scheduled');
  }, TEST_TIMEOUT_MS);

  it('9. reports a wrong current link with no exact candidate and keeps the patient dose visible', async () => {
    await insertPatient(TENANT_A, P_STALE, dobYearsAgo(2));
    await seedScheduleForPatient({ patientUid: P_STALE, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const otherNewborn = await insertNewborn(TENANT_A, P_OTHER_IDENTITY);
    const wrongDose = await insertNewbornDose(TENANT_A, otherNewborn, cat.a.BCG, {
      status: 'given',
      givenAt: '2022-03-01T05:00:00.000Z',
    });
    await prisma.$executeRawUnsafe(
      `UPDATE patient_immunisations
          SET newborn_immunisation_id = $1::int
        WHERE tenant_id = $2::uuid
          AND patient_uid = $3::uuid
          AND vaccine_catalogue_id = $4::int`,
      wrongDose, TENANT_A, P_STALE, cat.a.BCG,
    );

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const rec = report.records.find(
      (x) => x.patient_uid === P_STALE && x.code === 'BCG',
    );
    expect(rec.reason).toBe('stale_or_mismatched_link');
    expect(rec.current_link).toBe(wrongDose);
    expect(rec.newborn_count).toBe(0);
    expect(rec.candidate_newborn_immunisation_ids).toEqual([]);

    const full = await listForPatient(P_STALE, { tenantId: TENANT_A });
    const bcg = full.filter((row) => row.code === 'BCG');
    expect(bcg).toHaveLength(1);
    expect(bcg[0].status).toBe('scheduled');
    expect(bcg[0].given_at).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('10. reports and stops trusting an exact link after a second newborn makes identity ambiguous', async () => {
    await insertPatient(TENANT_A, P_AMBIGUOUS_AFTER_LINK, dobYearsAgo(2));
    const firstNewborn = await insertNewborn(TENANT_A, P_AMBIGUOUS_AFTER_LINK);
    const firstDose = await insertNewbornDose(TENANT_A, firstNewborn, cat.a.BCG, {
      status: 'given',
      givenAt: '2022-04-01T05:00:00.000Z',
    });
    await seedScheduleForPatient({
      patientUid: P_AMBIGUOUS_AFTER_LINK,
      dob: dobYearsAgo(2),
      tenantId: TENANT_A,
    });

    const secondNewborn = await insertNewborn(TENANT_A, P_AMBIGUOUS_AFTER_LINK);

    const report = await buildLinkageReport({ tenantId: TENANT_A });
    const rec = report.records.find(
      (x) => x.patient_uid === P_AMBIGUOUS_AFTER_LINK && x.code === 'BCG',
    );
    expect(rec.reason).toBe('multiple_newborns');
    expect(rec.current_link).toBe(firstDose);
    expect(rec.newborn_count).toBe(2);
    expect(rec.newborn_dose_count).toBe(1);
    expect(rec.candidate_newborn_ids)
      .toEqual([firstNewborn, secondNewborn].sort((a, b) => a - b));
    expect(rec.candidate_newborn_immunisation_ids).toEqual([firstDose]);
    expect(rec.candidate_doses).toEqual([{
      newborn_id: firstNewborn,
      newborn_immunisation_id: firstDose,
      newborn_due_date: '2022-01-01',
      newborn_status: 'given',
      newborn_given_at: '2022-04-01T05:00:00.000Z',
    }]);

    const full = await listForPatient(P_AMBIGUOUS_AFTER_LINK, { tenantId: TENANT_A });
    const bcg = full.filter((row) => row.code === 'BCG');
    expect(bcg).toHaveLength(1);
    // Ambiguous newborn history is never projected over the patient row.
    expect(bcg[0].status).toBe('scheduled');
    expect(bcg[0].given_at).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('11. blocks a competing newborn/dose insert until exact resolution and schedule write commit', async () => {
    await insertPatient(TENANT_A, P_RACE, dobYearsAgo(2));
    const firstNewborn = await insertNewborn(TENANT_A, P_RACE);
    const firstDose = await insertNewbornDose(TENANT_A, firstNewborn, cat.a.BCG, {
      status: 'given',
      givenAt: '2022-05-01T05:00:00.000Z',
    });
    const competingDelivery = await insertDelivery(TENANT_A, {
      birthIso: '2022-01-01T04:05:00Z',
    });

    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS o1_pause_seed_race ON patient_immunisations',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS o1_pause_seed_race()');
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION o1_pause_seed_race()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $o1$
       BEGIN
         IF NEW.patient_uid = 'a1a1a1a1-0000-4000-8000-000000000010'::uuid
            AND current_setting('o1.seed_race_paused', true) IS DISTINCT FROM 'yes'
         THEN
           PERFORM set_config('o1.seed_race_paused', 'yes', true);
           PERFORM pg_advisory_xact_lock(7010101::bigint);
           PERFORM pg_sleep(2);
         END IF;
         RETURN NEW;
       END;
       $o1$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER o1_pause_seed_race
       BEFORE INSERT ON patient_immunisations
       FOR EACH ROW EXECUTE FUNCTION o1_pause_seed_race()`,
    );

    let seedOutcomePromise;
    let competingOutcomePromise;
    try {
      seedOutcomePromise = seedScheduleForPatient({
        patientUid: P_RACE,
        dob: dobYearsAgo(2),
        tenantId: TENANT_A,
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );

      // The trigger runs only after the service has acquired SHARE locks on
      // both candidate tables. Its advisory marker makes the race deterministic.
      await waitForRaceMarker();

      let competingSettled = false;
      competingOutcomePromise = prisma.$transaction(async (tx) => {
        const newbornRows = await tx.$queryRawUnsafe(
          `INSERT INTO maternity_newborns
             (delivery_id, birth_datetime, outcome, newborn_patient_uid, tenant_id)
           VALUES ($1::int, '2022-01-01T04:05:00Z'::timestamptz,
                   'live', $2::uuid, $3::uuid)
           RETURNING id`,
          competingDelivery, P_RACE, TENANT_A,
        );
        const competingNewborn = Number(newbornRows[0].id);
        const doseRows = await tx.$queryRawUnsafe(
          `INSERT INTO newborn_immunisations
             (newborn_id, vaccine_catalogue_id, due_date, status, tenant_id)
           VALUES ($1::int, $2::int, '2022-01-01'::date, 'scheduled', $3::uuid)
           RETURNING id`,
          competingNewborn, cat.a.BCG, TENANT_A,
        );
        return {
          newbornId: competingNewborn,
          doseId: Number(doseRows[0].id),
        };
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      ).finally(() => {
        competingSettled = true;
      });

      // While the seed is paused inside its INSERT, the competing maternity
      // write must still be blocked by the candidate-table SHARE lock.
      await delay(100);
      expect(competingSettled).toBe(false);
      const duringRace = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total
           FROM maternity_newborns
          WHERE tenant_id = $1::uuid
            AND newborn_patient_uid = $2::uuid`,
        TENANT_A, P_RACE,
      );
      expect(Number(duringRace[0].total)).toBe(1);

      const seedOutcome = await seedOutcomePromise;
      if (!seedOutcome.ok) throw seedOutcome.error;
      expect(seedOutcome.value.linked).toBe(1);

      const competingOutcome = await competingOutcomePromise;
      if (!competingOutcome.ok) throw competingOutcome.error;

      const rows = await patientRows(TENANT_A, P_RACE);
      const storedBcg = rows.find((row) => row.code === 'BCG');
      expect(storedBcg.newborn_immunisation_id).toBe(firstDose);
      expect(storedBcg.status).toBe('scheduled');

      const report = await buildLinkageReport({ tenantId: TENANT_A });
      const rec = report.records.find(
        (record) => record.patient_uid === P_RACE && record.code === 'BCG',
      );
      expect(rec.reason).toBe('multiple_doses');
      expect(rec.current_link).toBe(firstDose);
      expect(rec.newborn_count).toBe(2);
      expect(rec.newborn_dose_count).toBe(2);
      expect(rec).toMatchObject({
        vaccine_catalogue_id: cat.a.BCG,
        code: 'BCG',
        dose_number: null,
        schedule_source: 'uip',
        source_version: 'test-v1',
        patient_status: 'scheduled',
        newborn_id: null,
        newborn_immunisation_id: null,
        newborn_due_date: null,
        newborn_status: null,
      });
      expect(rec.patient_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rec.candidate_newborn_ids).toEqual(
        [firstNewborn, competingOutcome.value.newbornId].sort((a, b) => a - b),
      );
      expect(rec.candidate_newborn_immunisation_ids).toEqual(
        [firstDose, competingOutcome.value.doseId].sort((a, b) => a - b),
      );
      expect(rec.candidate_doses).toHaveLength(2);
      expect(rec.candidate_doses.every((candidate) => (
        candidate.newborn_due_date === '2022-01-01'
        && ['given', 'scheduled'].includes(candidate.newborn_status)
      ))).toBe(true);

      const full = await listForPatient(P_RACE, { tenantId: TENANT_A });
      const visibleBcg = full.filter((row) => row.code === 'BCG');
      expect(visibleBcg).toHaveLength(1);
      // Once the later write makes identity ambiguous, the stale link is kept
      // for evidence but is no longer trusted for the read projection.
      expect(visibleBcg[0].status).toBe('scheduled');
      expect(visibleBcg[0].given_at).toBeNull();
    } finally {
      await Promise.allSettled(
        [seedOutcomePromise, competingOutcomePromise].filter(Boolean),
      );
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS o1_pause_seed_race ON patient_immunisations',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS o1_pause_seed_race()');
    }
  }, TEST_TIMEOUT_MS);
});
