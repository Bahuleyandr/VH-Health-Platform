// immunisation-linkage-reconciliation.deep.test.js
//
// O1 — exact, unambiguous newborn↔patient immunisation identity linkage
// and the read-only tenant-scoped reconciliation report.
//
// Covers the eight mandated cases:
//   1. exact link                 — one newborn + one matching newborn dose → back-link written
//   2. no match                   — walk-in patient (no newborn) → unlinked, normal seed
//   3. multiple newborns          — >1 newborn for the uid → refuse link, reported
//   4. multiple dose candidates   — >1 matching newborn dose for the uid → refuse link, reported
//   5. tenant isolation           — a newborn dose in tenant A never links a seed in tenant B
//   6. idempotent repeat seed     — re-seeding does not duplicate or re-link; report is stable
//   7. deduped read               — a linked dose is not surfaced as a second independent patient dose
//   8. administered-history       — a 'given' newborn dose is never mutated/merged/copied by linkage
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

/**
 * Build a maternity newborn (pregnancy → delivery → newborn) and return its id.
 * The newborn is linked to `babyUid` via newborn_patient_uid unless null.
 */
async function insertNewborn(tenantId, babyUid, { birthIso = '2022-01-01T04:00:00Z' } = {}) {
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
  const newborn = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_datetime, outcome, newborn_patient_uid, tenant_id)
     VALUES ($1::int, $2::timestamptz, 'live', $3, $4::uuid) RETURNING id`,
    Number(delivery[0].id), birthIso, babyUid /* may be null */, tenantId,
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
    const doseId = await insertNewbornDose(TENANT_A, newbornId, cat.a.BCG);

    await seedScheduleForPatient({ patientUid: P_EXACT, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const rows = await patientRows(TENANT_A, P_EXACT);
    const bcg = rows.find((r) => r.code === 'BCG');
    const hepb = rows.find((r) => r.code === 'HEPB');
    expect(bcg.newborn_immunisation_id).toBe(doseId);
    // Vaccines with no matching newborn dose stay unlinked.
    expect(hepb.newborn_immunisation_id).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('2. leaves every dose unlinked for a walk-in patient with no newborn', async () => {
    await insertPatient(TENANT_A, P_WALKIN, dobYearsAgo(2));
    await seedScheduleForPatient({ patientUid: P_WALKIN, dob: dobYearsAgo(2), tenantId: TENANT_A });

    const rows = await patientRows(TENANT_A, P_WALKIN);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.newborn_immunisation_id === null)).toBe(true);
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
    expect(rec.current_link).toBeNull();
    // nb2 exists but is unused here; reference to keep lints honest.
    expect(nb2).toBeGreaterThan(0);
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
    // Two matching newborn doses were detected as the ambiguity.
    expect(rec.newborn_dose_count).toBe(2);
    expect(['multiple_newborns', 'multiple_doses']).toContain(rec.reason);
    expect(rec.current_link).toBeNull();
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

    // The tenant-B report must not surface tenant-A's dose.
    const reportB = await buildLinkageReport({ tenantId: TENANT_B });
    expect(reportB.records.some((x) => x.patient_uid === P_ISO)).toBe(false);
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

  it('7. deduped read: an exactly linked dose is not shown as a second independent patient dose', async () => {
    // P_EXACT (from test 1) has BCG linked, HEPB/OPV unlinked.
    const full = await listForPatient(P_EXACT, { tenantId: TENANT_A });
    expect(full.some((r) => r.code === 'BCG')).toBe(false);
    expect(full.some((r) => r.code === 'HEPB')).toBe(true);

    const due = await listDueForPatient(P_EXACT, { tenantId: TENANT_A });
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
});
