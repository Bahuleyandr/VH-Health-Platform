// Guard regression for the NL-5 P4 immunisation schedule importer.
//
// The importer probes existing catalogue rows on (tenant_id, code, dose_number)
// and only retires rows whose schedule_source matches the pack being imported.
// Run against the migration-160 seed (29 rows, all schedule_source='custom')
// that means a `--schedule uip` run FORKS the catalogue instead of replacing it:
//
//   * migration 160 seeds BCG with dose_number = NULL; the UIP pack ships BCG
//     dose 1 -> the probe cannot match -> a SECOND active BCG row is inserted.
//   * the UIP pack ships PENTA; migration 160 has the decomposed DPT/HEPB/HIB
//     components. They are 'custom', so retireMissingRows never sees them and
//     they stay active -> every newly seeded child is booked for pentavalent
//     AND each of its three component antigens. Same shape for IPV vs FIPV.
//
// These tests pin the guard: an import that would leave any active row outside
// the incoming pack must refuse, and must only proceed under an explicit
// operator disposition.
//
// The fixture is COPIED FROM THE REAL DEFAULT-TENANT CATALOGUE rather than
// hand-written, so a transcription slip cannot make these tests pass vacuously.

import pg from 'pg';
import prisma from '../lib/prisma.js';
// Namespace import: a named import of a not-yet-existing export is a link-time
// SyntaxError that would take the whole file down, hiding the real failures.
import * as importer from '../../scripts/immunisation-schedule-import.mjs';

const { importScheduleRows, planImport, buildScheduleRows, UIP_SCHEDULE_ROWS } = importer;

const GUARD_TENANT_ID = 'e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e601';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const GUARD_TEST_TIMEOUT_MS = 60_000;

function keyOf(row) {
  return `${row.code}::${row.dose_number == null ? 'NULL' : row.dose_number}`;
}

async function activeCatalogue(tenantId) {
  return prisma.$queryRawUnsafe(
    `SELECT code, dose_number, active, schedule_source, recommended_age_days
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND active = TRUE
      ORDER BY code, dose_number NULLS FIRST`,
    tenantId,
  );
}

async function allCatalogue(tenantId) {
  return prisma.$queryRawUnsafe(
    `SELECT code, dose_number, active, schedule_source
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid
      ORDER BY code, dose_number NULLS FIRST`,
    tenantId,
  );
}

async function seedGuardTenantFromRealCatalogue() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO vaccine_catalogue
       (tenant_id, code, display_name, dose_number, recommended_age_days,
        window_days, description, active, schedule_source, source_version)
     SELECT $1::uuid, code, display_name, dose_number, recommended_age_days,
            window_days, description, active, schedule_source, source_version
       FROM vaccine_catalogue
      WHERE tenant_id = $2::uuid`,
    GUARD_TENANT_ID, DEFAULT_TENANT_ID,
  );
}

async function cleanupGuardTenant() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM immunisation_schedule_import_batches WHERE tenant_id = $1::uuid`,
    GUARD_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vaccine_catalogue WHERE tenant_id = $1::uuid`,
    GUARD_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    GUARD_TENANT_ID,
  ).catch(() => {});
}

describe('Immunisation schedule importer — catalogue fork guard', () => {
  let pgClient;

  beforeAll(async () => {
    await cleanupGuardTenant();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'importer-guard-test', 'Importer Guard Test Tenant')
       ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name`,
      GUARD_TENANT_ID,
    );
    await seedGuardTenantFromRealCatalogue();
    pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
  }, GUARD_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pgClient) await pgClient.end();
    await cleanupGuardTenant();
    await prisma.$disconnect().catch(() => {});
  }, GUARD_TEST_TIMEOUT_MS);

  // Fixture integrity: if migration 160's seed ever changes shape, the fork
  // tests below could silently stop exercising the fork. Fail loudly instead.
  it('fixture reproduces the migration-160 seed shape that triggers the fork', async () => {
    const rows = await activeCatalogue(GUARD_TENANT_ID);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    expect(rows.every((r) => r.schedule_source === 'custom')).toBe(true);

    const bcg = rows.filter((r) => r.code === 'BCG');
    expect(bcg).toHaveLength(1);
    expect(bcg[0].dose_number).toBeNull();

    const keys = new Set(rows.map(keyOf));
    // The decomposed components the UIP pack replaces with PENTA.
    expect(keys.has('DPT::1')).toBe(true);
    expect(keys.has('HIB::1')).toBe(true);
    expect(keys.has('HEPB::1')).toBe(true);
    expect(keys.has('IPV::1')).toBe(true);
    expect(keys.has('PENTA::1')).toBe(false);
  }, GUARD_TEST_TIMEOUT_MS);

  it('refuses a UIP import that would leave migration-160 rows active alongside the pack', async () => {
    const before = await allCatalogue(GUARD_TENANT_ID);

    await expect(importScheduleRows({
      client: pgClient,
      tenantId: GUARD_TENANT_ID,
      schedule: 'uip',
      version: 'guard-refuse',
    })).rejects.toThrow(/IMMUNISATION_IMPORT_WOULD_FORK_CATALOGUE/);

    // Nothing was written: no PENTA, still exactly one BCG, catalogue untouched.
    const after = await allCatalogue(GUARD_TENANT_ID);
    expect(after).toEqual(before);
    expect(after.some((r) => r.code === 'PENTA')).toBe(false);
    expect(after.filter((r) => r.code === 'BCG')).toHaveLength(1);
  }, GUARD_TEST_TIMEOUT_MS);

  it('names the surviving rows in the refusal so the operator can disposition them', async () => {
    let caught = null;
    try {
      await importScheduleRows({
        client: pgClient,
        tenantId: GUARD_TENANT_ID,
        schedule: 'uip',
        version: 'guard-detail',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    const survivorKeys = new Set((caught.survivors || []).map(keyOf));
    // The BCG identity collision (NULL dose vs pack dose 1).
    expect(survivorKeys.has('BCG::NULL')).toBe(true);
    // The pentavalent components that would otherwise stay active beside PENTA.
    expect(survivorKeys.has('DPT::1')).toBe(true);
    expect(survivorKeys.has('DPT::2')).toBe(true);
    expect(survivorKeys.has('DPT::3')).toBe(true);
    expect(survivorKeys.has('HIB::1')).toBe(true);
    expect(survivorKeys.has('HEPB::1')).toBe(true);
    expect(survivorKeys.has('IPV::1')).toBe(true);

    // The dose-identity collision is reported as its own class: same code, but
    // the pack and the catalogue disagree on whether the dose is numbered.
    const collisionCodes = new Set((caught.collisions || []).map((c) => c.code));
    expect(collisionCodes.has('BCG')).toBe(true);
  }, GUARD_TEST_TIMEOUT_MS);

  it('dry-run plan reports the diff and writes nothing', async () => {
    const before = await allCatalogue(GUARD_TENANT_ID);

    const plan = await planImport(pgClient, {
      tenantId: GUARD_TENANT_ID,
      schedule: 'uip',
      rows: buildScheduleRows('uip'),
    });

    const insertKeys = new Set(plan.inserts.map(keyOf));
    expect(insertKeys.has('PENTA::1')).toBe(true);
    expect(insertKeys.has('BCG::1')).toBe(true);
    expect(insertKeys.has('FIPV::1')).toBe(true);

    // PCV 3 key-matches (custom, 98d) and would be rewritten in place to 274d.
    const pcv3 = plan.updates.find((u) => u.code === 'PCV' && u.dose_number === 3);
    expect(pcv3).toBeDefined();
    expect(pcv3.before.recommended_age_days).toBe(98);
    expect(pcv3.after.recommended_age_days).toBe(274);

    expect(plan.survivors.length).toBeGreaterThan(0);
    expect(await allCatalogue(GUARD_TENANT_ID)).toEqual(before);
  }, GUARD_TEST_TIMEOUT_MS);

  it('applies cleanly under an explicit retire-survivors disposition, leaving no fork', async () => {
    const result = await importScheduleRows({
      client: pgClient,
      tenantId: GUARD_TENANT_ID,
      schedule: 'uip',
      version: 'guard-apply',
      retireSurvivors: true,
    });
    expect(result.status).toBe('completed');

    const active = await activeCatalogue(GUARD_TENANT_ID);
    const activeKeys = new Set(active.map(keyOf));
    const packKeys = new Set(UIP_SCHEDULE_ROWS.map(keyOf));

    // The invariant: after the run, every active row belongs to the incoming pack.
    expect(activeKeys).toEqual(packKeys);

    // The two fork classes, named explicitly for diagnosis.
    const activeBcg = active.filter((r) => r.code === 'BCG');
    expect(activeBcg).toHaveLength(1);
    expect(activeBcg[0].dose_number).toBe(1);

    expect(activeKeys.has('PENTA::1')).toBe(true);
    for (const componentKey of ['DPT::1', 'DPT::2', 'DPT::3', 'HIB::1', 'HIB::2', 'HIB::3', 'HEPB::1', 'HEPB::3', 'IPV::1', 'IPV::2']) {
      expect(activeKeys.has(componentKey)).toBe(false);
    }
  }, GUARD_TEST_TIMEOUT_MS);

  it('rolls the whole run back when a row fails mid-import', async () => {
    const before = await allCatalogue(GUARD_TENANT_ID);

    const good = { schedule_source: 'uip', code: 'ROLLBACKOK', display_name: 'Rollback probe', dose_number: 1, recommended_age_days: 10, window_days: 7, description: null };
    // code is VARCHAR(40): 60 chars fails the INSERT with 22001 mid-loop.
    const poison = { schedule_source: 'uip', code: 'X'.repeat(60), display_name: 'Poison row', dose_number: 1, recommended_age_days: 10, window_days: 7, description: null };

    await expect(importScheduleRows({
      client: pgClient,
      tenantId: GUARD_TENANT_ID,
      schedule: 'uip',
      version: 'guard-rollback',
      rows: [good, poison],
      retireSurvivors: true,
    })).rejects.toThrow();

    // The good row must NOT have been committed, and nothing else may have moved.
    const after = await allCatalogue(GUARD_TENANT_ID);
    expect(after.some((r) => r.code === 'ROLLBACKOK')).toBe(false);
    expect(after).toEqual(before);

    const batches = await prisma.$queryRawUnsafe(
      `SELECT status FROM immunisation_schedule_import_batches
        WHERE tenant_id = $1::uuid AND source_version = 'guard-rollback'`,
      GUARD_TENANT_ID,
    );
    // The audit row survives the data rollback and records the failure.
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe('failed');
  }, GUARD_TEST_TIMEOUT_MS);
});
