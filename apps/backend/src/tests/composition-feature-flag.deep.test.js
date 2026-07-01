import prisma from '../lib/prisma.js';
import {
  isCompositionSearchEnabled,
  setCompositionSearchEnabled,
} from '../services/pharmacy/compositionFeatureService.js';

// Unique tenant id for this suite to avoid collisions with other deep tests.
const TENANT = '00000000-0000-4000-8000-0000000c0f01';
// A second tenant used by the cache-isolation regression test. It has a
// tenants row but NO composition_search_settings row.
const TENANT_B = '00000000-0000-4000-8000-0000000c0f02';
const UNKNOWN_TENANT = '00000000-0000-4000-8000-0000000c0f99';

describe('compositionFeatureService (per-tenant composition-search flag)', () => {
  beforeAll(async () => {
    // Seed the tenant rows (FK target). Some tenant ids FK-fail if absent.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
      'comp-flag-test',
      'Composition Flag Test Tenant',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
      'comp-flag-test-b',
      'Composition Flag Test Tenant B',
    );
    // Clean any prior rows so default-state assertions are meaningful.
    await prisma.$executeRawUnsafe(
      `DELETE FROM composition_search_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT,
      TENANT_B,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM composition_search_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT,
      TENANT_B,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('defaults to false when no settings row exists for the tenant', async () => {
    const enabled = await isCompositionSearchEnabled(TENANT);
    expect(enabled).toBe(false);
  });

  it('upserts an enabled row with the acceptance snapshot and flips isEnabled to true', async () => {
    const snapshot = {
      coverage: 0.92,
      curatedCount: 1234,
      unresolvedCount: 5,
      acceptedBy: 'pharmacy-lead',
    };
    const row = await setCompositionSearchEnabled(TENANT, true, {
      actorUid: '11111111-1111-4111-8111-111111111111',
      snapshot,
    });

    expect(row).toBeTruthy();
    expect(row.enabled).toBe(true);
    expect(row.enabled_at).toBeTruthy();
    expect(String(row.enabled_by)).toBe('11111111-1111-4111-8111-111111111111');
    // acceptance_snapshot round-trips as the object we stored.
    expect(row.acceptance_snapshot).toEqual(snapshot);

    // Verify what actually landed in the DB (independent of cache).
    const dbRows = await prisma.$queryRawUnsafe(
      `SELECT enabled, enabled_at, enabled_by, acceptance_snapshot
         FROM composition_search_settings WHERE tenant_id = $1::uuid`,
      TENANT,
    );
    expect(dbRows.length).toBe(1);
    expect(dbRows[0].enabled).toBe(true);
    expect(dbRows[0].enabled_at).toBeTruthy();
    expect(dbRows[0].acceptance_snapshot).toEqual(snapshot);

    // And the service now resolves true (cache updated synchronously on write).
    const enabled = await isCompositionSearchEnabled(TENANT);
    expect(enabled).toBe(true);
  });

  it('returns a stable value across two immediate reads (cache correctness)', async () => {
    const first = await isCompositionSearchEnabled(TENANT);
    const second = await isCompositionSearchEnabled(TENANT);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(first).toBe(second);
  });

  it('flipping back to false clears enabled and resolves false', async () => {
    await setCompositionSearchEnabled(TENANT, false, {
      actorUid: '22222222-2222-4222-8222-222222222222',
    });
    const enabled = await isCompositionSearchEnabled(TENANT);
    expect(enabled).toBe(false);

    const dbRows = await prisma.$queryRawUnsafe(
      `SELECT enabled FROM composition_search_settings WHERE tenant_id = $1::uuid`,
      TENANT,
    );
    expect(dbRows[0].enabled).toBe(false);
  });

  it('returns false and never throws for unknown tenant', async () => {
    await expect(isCompositionSearchEnabled(UNKNOWN_TENANT)).resolves.toBe(false);
  });

  it('returns false and never throws for null / undefined tenantId', async () => {
    await expect(isCompositionSearchEnabled(null)).resolves.toBe(false);
    await expect(isCompositionSearchEnabled(undefined)).resolves.toBe(false);
    await expect(isCompositionSearchEnabled('')).resolves.toBe(false);
  });

  it('reading another tenant never evicts/poisons this tenant\'s cache entry', async () => {
    // Regression for the global-refresh cache-poisoning defect: the old design
    // did `SELECT ... FROM composition_search_settings` (all rows) + `.clear()`,
    // so reading tenant B — especially under an ambient tenant-A RLS GUC —
    // would return only B's rows (or none) and WIPE tenant A's warmed entry,
    // leaving A reading false for the next 60s TTL. A per-tenant keyed cache
    // must never let one tenant's read mutate another's entry.
    await setCompositionSearchEnabled(TENANT, true, {
      actorUid: '33333333-3333-4333-8333-333333333333',
      snapshot: { coverage: 1.0 },
    });
    expect(await isCompositionSearchEnabled(TENANT)).toBe(true); // warms A

    // Read a DIFFERENT tenant B that has no settings row.
    expect(await isCompositionSearchEnabled(TENANT_B)).toBe(false);

    // A must still be enabled — reading B did not evict/poison A's entry.
    expect(await isCompositionSearchEnabled(TENANT)).toBe(true);
  });
});
