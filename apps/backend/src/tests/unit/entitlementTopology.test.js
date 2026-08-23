// Pins the entitlement catalog's enforcement promises to the actual gate
// topology (once-over 2026-08-23): migration 433 seeded admin.operations as
// enforcement_mode='hard_block' over /api/v1/admin, but no requireEntitlement
// mount existed for it — the catalog promised enforcement that did not exist,
// and nothing failed CI when the two drifted. These pins make that drift a
// red build in both directions.
//
// Source-scan by design: the catalog lives in migration SQL and the topology
// in routes/admin/index.js, so this suite parses both files rather than
// booting the app or a DB.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ENTITLEMENT_FEATURE_KEYS } from '../../services/entitlements/entitlementService.js';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const catalogSql = readFileSync(
  resolve(backendRoot, 'src/migrations/433_entitlement_packaging_catalog.sql'),
  'utf8',
);
const adminIndexSource = readFileSync(
  resolve(backendRoot, 'src/routes/admin/index.js'),
  'utf8',
);

// Feature tuples in 433 look like:  ( 'feature.key', ..., 'hard_block', ...
// Capture each feature key whose tuple declares hard_block enforcement.
function hardBlockFeatureKeysFromCatalog() {
  const keys = [];
  const tupleRe = /\(\s*'([a-z_.]+)',[\s\S]*?'(hard_block|status_only|audit_only)'/g;
  const insertBlock = catalogSql.slice(
    catalogSql.indexOf('INSERT INTO product_features'),
    catalogSql.indexOf('INSERT INTO product_packages'),
  );
  let m;
  while ((m = tupleRe.exec(insertBlock)) !== null) {
    if (m[2] === 'hard_block') keys.push(m[1]);
  }
  return new Set(keys);
}

function gatedFeatureKeysFromRouter() {
  const gated = new Set();
  const gateRe = /requireEntitlement\(ENTITLEMENT_FEATURE_KEYS\.([A-Za-z0-9_]+)\)/g;
  let m;
  while ((m = gateRe.exec(adminIndexSource)) !== null) {
    const key = ENTITLEMENT_FEATURE_KEYS[m[1]];
    expect(key).toBeDefined();
    gated.add(key);
  }
  return gated;
}

describe('entitlement catalog ↔ gate topology', () => {
  it('every hard_block admin/commercial/developer feature has a mounted gate', () => {
    const hardBlock = hardBlockFeatureKeysFromCatalog();
    // The catalog must actually parse — an empty set means the regex or the
    // migration moved, and this suite must be updated rather than pass vacuously.
    expect(hardBlock.size).toBeGreaterThanOrEqual(4);

    const gated = gatedFeatureKeysFromRouter();
    const ungated = [...hardBlock].filter((key) => !gated.has(key));
    expect(ungated).toEqual([]);
  });

  it('the admin.operations gate is barrel-wide (no path argument)', () => {
    expect(adminIndexSource).toMatch(
      /router\.use\(requireEntitlement\(ENTITLEMENT_FEATURE_KEYS\.adminOperations\)\);/,
    );
  });

  it('the entitlement recovery surface mounts ABOVE the barrel gate', () => {
    const recoveryAt = adminIndexSource.indexOf("router.use('/entitlements', entitlementRoutes);");
    const gateAt = adminIndexSource.indexOf(
      'router.use(requireEntitlement(ENTITLEMENT_FEATURE_KEYS.adminOperations));',
    );
    expect(recoveryAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(recoveryAt).toBeLessThan(gateAt);
  });

  it('the catalog file is still the only product_features seeder', () => {
    // If a later migration starts inserting features, extend
    // hardBlockFeatureKeysFromCatalog to read it too — this pin makes that
    // omission loud instead of silent.
    expect(catalogSql).toContain('INSERT INTO product_features');
  });
});
