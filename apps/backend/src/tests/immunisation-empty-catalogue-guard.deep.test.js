// D6-R2 guard: a tenant with no ACTIVE vaccine_catalogue rows must not seed a
// silently empty immunisation schedule.
//
// Onboarding never seeds a catalogue (choosing a pack is the unsigned D6
// decision), so a freshly onboarded tenant has zero rows. Both seeders used to
// report `{inserted:0, total:0}` as SUCCESS against that — a new hospital's
// babies got NO schedule and nobody was told. The seeders now fail closed with
// a 422 IMMUNISATION_SCHEDULE_NOT_CONFIGURED, and onboarding reports the gap.
//
// The load-bearing distinction: the guard keys on catalogue POPULATION, never on
// insert count. An idempotent re-seed (catalogue present, every dose already
// inserted, `inserted=0`) MUST still succeed — the negative test below pins that.

import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { seedScheduleForNewborn } from '../services/maternity/immunisationService.js';
import { seedScheduleForPatient } from '../services/paediatric/paediatricImmunisationService.js';
import * as catalogueStatus from '../services/immunisation/catalogueStatus.js';

const EMPTY_TENANT = 'e2e2e2e2-0000-4e2e-8e2e-e2e2e2e2e201';
const SEEDED_TENANT = 'e2e2e2e2-0000-4e2e-8e2e-e2e2e2e2e202';
const ACTOR_UID = 'e2e2e2e2-0000-4e2e-8e2e-e2e2e2e2e2ff';
const TIMEOUT = 60_000;

let phoneSeq = 700000;
function nextPhone() { phoneSeq += 1; return `9${phoneSeq}`; }

async function makeTenant(id, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug`,
    id, slug, `Guard test ${slug}`,
  );
}

async function seedUser(tenantId, { role = 'PATIENT', birthday = '2026-06-08' } = {}) {
  const uid = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, birthday, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::date, true, $6::uuid, NOW())`,
    uid, nextPhone(), `Guard ${role} ${uid.slice(0, 8)}`, role, birthday, tenantId,
  );
  return uid;
}

// Full birth chain with a valid, distinct Shape-3 newborn identity (post-#595
// the seeder rejects an absent/mother/invalid link).
async function seedNewborn(tenantId) {
  const motherUid = await seedUser(tenantId);
  const infantUid = await seedUser(tenantId);
  const preg = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-09-01', '2026-06-08', 'delivered', $2::uuid, $3::uuid)
     RETURNING id`,
    motherUid, ACTOR_UID, tenantId,
  );
  const delivery = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries
       (pregnancy_id, delivery_datetime, delivery_mode, delivered_by, tenant_id)
     VALUES ($1::int, '2026-06-08T04:00:00Z', 'nvd', $2::uuid, $3::uuid)
     RETURNING id`,
    Number(preg[0].id), ACTOR_UID, tenantId,
  );
  const newborn = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_datetime, outcome, newborn_patient_uid, recorded_by, tenant_id)
     VALUES ($1::int, '2026-06-08T04:00:00Z', 'live', $2::uuid, $3::uuid, $4::uuid)
     RETURNING id`,
    Number(delivery[0].id), infantUid, ACTOR_UID, tenantId,
  );
  return { newbornId: Number(newborn[0].id), infantUid, motherUid };
}

async function seedCatalogueRow(tenantId, code, doseNumber, ageDays) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO vaccine_catalogue
       (tenant_id, code, display_name, dose_number, recommended_age_days,
        window_days, description, active, schedule_source)
     VALUES ($1::uuid, $2, $3, $4, $5, 28, 'guard test row', true, 'custom')`,
    tenantId, code, `${code} ${doseNumber ?? ''}`.trim(), doseNumber, ageDays,
  );
}

async function cleanup() {
  for (const t of [EMPTY_TENANT, SEEDED_TENANT]) {
    await prisma.$executeRawUnsafe(`DELETE FROM patient_immunisations WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM newborn_immunisations WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_newborns WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_deliveries WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM vaccine_catalogue WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, t).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, t).catch(() => {});
  }
}

// File-level hooks so both describes share one lifecycle — a describe-scoped
// afterAll would wipe SEEDED_TENANT's catalogue before the probe tests run.
beforeAll(async () => {
  await cleanup();
  await makeTenant(EMPTY_TENANT, 'guard-empty');
  await makeTenant(SEEDED_TENANT, 'guard-seeded');
  // SEEDED_TENANT gets a real 2-row catalogue, shared by the idempotent
  // re-seed test and the probe tests.
  await seedCatalogueRow(SEEDED_TENANT, 'BCG', null, 0);
  await seedCatalogueRow(SEEDED_TENANT, 'OPV', 0, 0);
}, TIMEOUT);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect().catch(() => {});
}, TIMEOUT);

describe('Immunisation seeders — empty-catalogue guard (D6-R2)', () => {
  it('newborn seed against an EMPTY catalogue throws NOT_CONFIGURED, not hollow success', async () => {
    const { newbornId } = await seedNewborn(EMPTY_TENANT);
    await expect(seedScheduleForNewborn({
      tenantId: EMPTY_TENANT,
      newborn_id: newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      code: 'IMMUNISATION_SCHEDULE_NOT_CONFIGURED',
      statusCode: 422,
    });

    // Nothing was written.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM newborn_immunisations WHERE tenant_id = $1::uuid`,
      EMPTY_TENANT,
    );
    expect(rows[0].n).toBe(0);
  }, TIMEOUT);

  it('paediatric seed against an EMPTY catalogue throws NOT_CONFIGURED', async () => {
    const patientUid = await seedUser(EMPTY_TENANT);
    await expect(seedScheduleForPatient({
      patientUid,
      dob: '2026-06-08',
      tenantId: EMPTY_TENANT,
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      code: 'IMMUNISATION_SCHEDULE_NOT_CONFIGURED',
      statusCode: 422,
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_immunisations WHERE tenant_id = $1::uuid`,
      EMPTY_TENANT,
    );
    expect(rows[0].n).toBe(0);
  }, TIMEOUT);

  it('an idempotent re-seed (catalogue present, inserted=0) does NOT throw', async () => {
    const patientUid = await seedUser(SEEDED_TENANT);

    const first = await seedScheduleForPatient({
      patientUid, dob: '2026-06-08', tenantId: SEEDED_TENANT, actorUid: ACTOR_UID, actorRole: 'NURSING_STAFF',
    });
    expect(first.inserted).toBe(2);

    // Second call inserts nothing (ON CONFLICT) — the guard must key on catalogue
    // POPULATION, not on inserted===0, so this must still succeed.
    const second = await seedScheduleForPatient({
      patientUid, dob: '2026-06-08', tenantId: SEEDED_TENANT, actorUid: ACTOR_UID, actorRole: 'NURSING_STAFF',
    });
    expect(second.inserted).toBe(0);
    expect(second.total).toBe(2);
  }, TIMEOUT);
});

describe('catalogueStatus probe (shared by seeders + onboarding)', () => {
  const PROBE_TENANT = EMPTY_TENANT;

  it('reports a configured tenant with its active count', async () => {
    const count = await catalogueStatus.getActiveCatalogueCount(SEEDED_TENANT);
    expect(count).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  it('reports zero for an unconfigured tenant', async () => {
    const count = await catalogueStatus.getActiveCatalogueCount(PROBE_TENANT);
    expect(count).toBe(0);
  }, TIMEOUT);

  it('assertScheduleConfigured throws 422 for an unconfigured tenant', async () => {
    await expect(catalogueStatus.assertScheduleConfigured(PROBE_TENANT))
      .rejects.toMatchObject({ code: 'IMMUNISATION_SCHEDULE_NOT_CONFIGURED', statusCode: 422 });
  }, TIMEOUT);

  it('assertScheduleConfigured resolves for a configured tenant', async () => {
    await expect(catalogueStatus.assertScheduleConfigured(SEEDED_TENANT)).resolves.toBeUndefined();
  }, TIMEOUT);
});
