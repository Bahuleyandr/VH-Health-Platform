import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const setTenantTx = jest.fn();
const loadActiveTherapySnapshot = jest.fn();
const loadDrugKbRevision = jest.fn();
const loadPharmacyOrderCommandReceiptTx = jest.fn();
const assertPharmacyFacilityGrant = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  loadActiveTherapySnapshot,
  validatePrescriptionSafety: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: jest.fn(),
  loadDrugKbRevision,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  recordMedicationSafetyReviews: jest.fn(),
}));
jest.unstable_mockModule('../../config/pharmacyConfig.js', () => ({
  BCMA_CONFIG: { requirePharmacistVerification: true },
  CLINICAL_VERIFICATION_STATUS: {
    PENDING: 'pending', VERIFIED: 'verified', OVERRIDE: 'override', REJECTED: 'rejected',
  },
  VERIFICATION_CLEARED_STATUSES: ['verified', 'override'],
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyOrderCommandReceiptService.js', () => ({
  loadPharmacyOrderCommandReceiptTx,
  storePharmacyOrderCommandReceiptTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant,
}));

const {
  assertVerificationCleared,
  clinicalCatalogAuthoritySha256Tx,
  clinicalOrderItemsSha256,
  requiresActiveTherapyReconciliation,
  verifyOrder,
} = await import('../../services/pharmacy/pharmacistVerificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const serviceSource = readFileSync(
  new URL('../../services/pharmacy/pharmacistVerificationService.js', import.meta.url),
  'utf8',
);
const facilityAuthoritySource = readFileSync(
  new URL('../../services/pharmacy/pharmacyFacilityAuthorityService.js', import.meta.url),
  'utf8',
);
const mergeStabilityLockSource = readFileSync(
  new URL('../../utils/patientMergeStabilityLock.js', import.meta.url),
  'utf8',
);

function expectMarkersInOrder(source, markers) {
  const offsets = markers.map((marker) => source.indexOf(marker));
  expect(offsets).not.toContain(-1);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
}

const items = [{
  order_line_index: 0,
  catalog_id: 17,
  name: 'Warfarin 5 mg',
  dose: '5 mg',
  route: 'oral',
  ordered_qty: 30,
}];

function buildDb() {
  let order = null;
  const statements = [];
  const db = {
    $queryRawUnsafe: jest.fn(async (sql) => {
      statements.push(sql);
      if (/pg_advisory_xact_lock/.test(sql)) return [{ pg_advisory_xact_lock: null }];
      if (/FROM pharmacy_orders po/.test(sql)) return order ? [order] : [];
      if (/FROM e_prescriptions/.test(sql)) return [];
      if (/FROM pharmacy_patient_safety_versions/.test(sql)) return [{ version: 5 }];
      if (/FROM pharmacy_catalog/.test(sql)) {
        return [{
          id: 17,
          name: 'Warfarin 5 mg',
          generic_name: 'warfarin',
          composition_id: 7,
          strength: '5 mg',
          strength_key: '5 mg',
          strength_components: null,
          form: 'tablet',
          form_key: 'tablet',
          release_key: null,
          route: 'oral',
          composition_source: 'governed',
          composition_confidence: 'verified',
        }];
      }
      if (/FROM drug_compositions/.test(sql)) {
        return [{
          id: 7,
          composition_key: 'warfarin',
          display_label: 'Warfarin',
          active_ingredients: ['warfarin'],
        }];
      }
      throw new Error(`Unexpected pharmacist staleness SQL: ${sql.slice(0, 100)}`);
    }),
  };
  return {
    db,
    statements,
    setOrder(value) { order = value; },
  };
}

async function verifiedFixture(activeTherapySha256 = 'a'.repeat(64)) {
  const fixture = buildDb();
  const catalogSha256 = await clinicalCatalogAuthoritySha256Tx(fixture.db, {
    tenantId: TENANT,
    itemsList: items,
  });
  fixture.statements.length = 0;
  fixture.db.$queryRawUnsafe.mockClear();
  fixture.setOrder({
    id: 71,
    status: 'CONFIRMED',
    delivery_type: 'pickup',
    patient_id: 91,
    patient_uid: PATIENT_UID,
    items_list: items,
    tenant_id: TENANT,
    facility_id: 7,
    authority_origin: 'patient_manual',
    inventory_authority_version: 4,
    clinically_verified_order_version: 4,
    clinical_verification_status: 'verified',
    clinical_verification_items_sha256: clinicalOrderItemsSha256(items),
    clinical_verification_catalog_sha256: catalogSha256,
    clinical_verification_active_therapy_sha256: activeTherapySha256,
    clinical_verification_safety_version: 5,
    clinical_verification_kb_version: 9,
    clinical_verification_ruleset_version: 2,
  });
  return fixture;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadDrugKbRevision.mockResolvedValue(9);
  loadActiveTherapySnapshot.mockResolvedValue({
    sha256: 'a'.repeat(64),
    blockers: [],
    evidence: [],
    medications: [],
  });
  assertPharmacyFacilityGrant.mockResolvedValue({
    actor_uid: '22222222-2222-4222-8222-222222222222',
    facility_id: 7,
  });
});

describe('pharmacist active-therapy staleness gate', () => {
  test.each([
    'ACTIVE_THERAPY_TIMING_UNRESOLVED',
    'ACTIVE_THERAPY_IDENTITY_UNRESOLVED',
    'ACTIVE_THERAPY_PATIENT_AUTHORITY_UNRESOLVED',
    'DRUG_KB_IDENTITY_UNRESOLVED',
    'DRUG_KB_UNAVAILABLE',
    'DRUG_KB_CHECK_ERROR',
    'SAFETY_CHECK_ERROR',
  ])('classifies %s as non-overridable reconciliation work', (type) => {
    expect(requiresActiveTherapyReconciliation([{ type }])).toBe(true);
  });

  test('does not convert a clinically reviewable allergy blocker into authority failure', () => {
    expect(requiresActiveTherapyReconciliation([{ type: 'ALLERGY_CONFLICT' }])).toBe(false);
  });

  test('rejects a verification when the canonical active-therapy hash changes', async () => {
    const fixture = await verifiedFixture('b'.repeat(64));
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(fixture.db));

    await expect(assertVerificationCleared(71, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    expect(loadActiveTherapySnapshot).toHaveBeenCalledWith(91, expect.objectContaining({
      tenantId: TENANT,
      db: fixture.db,
      excludePharmacyOrderId: 71,
    }));
    // Merge stability is a readers-writer lock now (`fix(patient): use readers
    // writer merge stability locks`): readers take the SHARED mode so unrelated
    // verifications run concurrently, while the merge itself still takes the
    // exclusive lock on the SAME key. Asserting both halves is strictly
    // stronger than the old single exclusive-mode match, which never proved the
    // two sides actually contend.
    expect(fixture.statements[0]).toMatch(
      /FROM pg_advisory_xact_lock_shared\(hashtextextended\(\$1::text, 0\)\)/,
    );
    expect(mergeStabilityLockSource).toMatch(
      /export async function lockTenantPatientMergeExecutionExclusive[\s\S]*FROM pg_advisory_xact_lock\(hashtextextended\(\$1::text, 0\)\)/,
    );
    expect(mergeStabilityLockSource).toContain(
      "const PATIENT_MERGE_LOCK_NAMESPACE = 'vhhealth:patient-merge-tenant:';",
    );
    expect(fixture.db.$queryRawUnsafe.mock.calls[0][1]).toBe(
      `vhhealth:patient-merge-tenant:${TENANT}`,
    );
    expect(fixture.statements[1]).toContain('vh:pharmacy_catalog_authority:');
    expect(fixture.db.$queryRawUnsafe.mock.calls[1][1]).toBe(TENANT);
    expect(fixture.statements[2]).toMatch(/FROM pharmacy_orders po/);
    expect(fixture.statements[3]).toMatch(/FROM e_prescriptions/);
  });

  test('verification paths preserve advisory and patient-authority lock order', () => {
    const assertBody = serviceSource.slice(
      serviceSource.indexOf('async function assertVerificationClearedWithDb'),
      serviceSource.indexOf('async function lockPatientSafetyVersionTx'),
    );
    const verifyBody = serviceSource.slice(
      serviceSource.indexOf('export async function verifyOrder'),
      serviceSource.indexOf('export async function ensurePackBarcode'),
    );

    expect(assertBody).toMatch(
      /lockTenantPatientMergeStability\(db, tid\);\s*await lockPharmacyCatalogAuthorityTx\(db, tid\);/,
    );
    expectMarkersInOrder(assertBody, [
      'lockTenantPatientMergeStability(db, tid)',
      'lockPharmacyCatalogAuthorityTx(db, tid)',
      'loadOrder(orderId, tid, db',
      'FROM e_prescriptions',
      'loadActiveTherapySnapshot(expectedPatientId',
    ]);

    expect(verifyBody).toMatch(
      /setTenantTx\(tid, async \(tx\) => \{\s*await lockTenantPatientMergeStability\(tx, tid\);\s*await lockPharmacyCatalogAuthorityTx\(tx, tid\);/,
    );
    expectMarkersInOrder(verifyBody, [
      'lockTenantPatientMergeStability(tx, tid)',
      'lockPharmacyCatalogAuthorityTx(tx, tid)',
      'const actors = await tx.$queryRawUnsafe',
      'loadOrder(orderId, tid, tx',
      'assertPharmacyFacilityGrant(tx',
      'FROM e_prescriptions ep',
      'const activePatientRows',
      'loadPharmacyOrderCommandReceiptTx(tx',
    ]);
    expect(verifyBody).toMatch(/SELECT id, uid, role[\s\S]*LIMIT 1\s*FOR UPDATE/);
    expect(verifyBody).toMatch(/FROM e_prescriptions ep[\s\S]*FOR UPDATE OF ep/);
    expect(verifyBody).toMatch(/const activePatientRows[\s\S]*LIMIT 1\s*FOR UPDATE/);
    expect(facilityAuthoritySource).toMatch(/FROM users actor[\s\S]*FOR UPDATE OF actor/);
    expect(facilityAuthoritySource).toMatch(
      /FROM pharmacy_staff_facility_grants[\s\S]*FOR UPDATE/,
    );
    expect(facilityAuthoritySource).not.toContain('FOR KEY SHARE');
  });

  test('receipt replay remains unavailable after verifier authority is revoked', async () => {
    const db = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (/pg_advisory_xact_lock/.test(sql)) return [{ lock_acquired: null }];
        if (/FROM users/.test(sql)) return [];
        throw new Error(`Unexpected verifier replay SQL: ${sql.slice(0, 100)}`);
      }),
    };
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(db));
    loadPharmacyOrderCommandReceiptTx.mockResolvedValue({
      payload: { order: { id: 71 }, replayed: true },
    });

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid: '22222222-2222-4222-8222-222222222222',
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: 'd'.repeat(64),
      requestSha256: 'e'.repeat(64),
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_VERIFY_ACTOR_IDENTITY_REQUIRED',
    });

    expect(loadPharmacyOrderCommandReceiptTx).not.toHaveBeenCalled();
    expect(assertPharmacyFacilityGrant).not.toHaveBeenCalled();
  });

  test('receipt replay remains unavailable after concurrent facility-grant revocation', async () => {
    const actorUid = '22222222-2222-4222-8222-222222222222';
    const db = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (/pg_advisory_xact_lock/.test(sql)) return [{ lock_acquired: null }];
        if (/FROM users/.test(sql)) {
          return [{ id: 22, uid: actorUid, role: 'PHARMACY_STAFF' }];
        }
        if (/FROM pharmacy_orders po/.test(sql)) {
          return [{ id: 71, tenant_id: TENANT, facility_id: 7 }];
        }
        throw new Error(`Unexpected verifier facility replay SQL: ${sql.slice(0, 100)}`);
      }),
    };
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(db));
    assertPharmacyFacilityGrant.mockRejectedValue(Object.assign(
      new Error('The actor has no active grant for this pharmacy facility'),
      { statusCode: 403, code: 'PHARMACY_FACILITY_GRANT_REQUIRED' },
    ));
    loadPharmacyOrderCommandReceiptTx.mockResolvedValue({
      payload: { order: { id: 71 }, replayed: true },
    });

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid,
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: 'f'.repeat(64),
      requestSha256: '0'.repeat(64),
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
    });

    expect(assertPharmacyFacilityGrant).toHaveBeenCalledWith(db, {
      tenantId: TENANT,
      facilityId: 7,
      actorUid,
      actorRole: 'PHARMACY_STAFF',
      forUpdate: true,
    });
    expect(loadPharmacyOrderCommandReceiptTx).not.toHaveBeenCalled();
  });

  test('receipt replay remains unavailable after the eRx link changes', async () => {
    const actorUid = '22222222-2222-4222-8222-222222222222';
    const db = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (/pg_advisory_xact_lock/.test(sql)) return [{ lock_acquired: null }];
        if (/SELECT id, uid, role/.test(sql)) {
          return [{ id: 22, uid: actorUid, role: 'PHARMACY_STAFF' }];
        }
        if (/FROM pharmacy_orders po/.test(sql)) {
          return [{
            id: 71,
            tenant_id: TENANT,
            facility_id: 7,
            patient_id: 91,
            patient_uid: PATIENT_UID,
            authority_origin: 'e_prescription',
          }];
        }
        if (/FROM e_prescriptions ep/.test(sql)) return [];
        throw new Error(`Unexpected verifier eRx replay SQL: ${sql.slice(0, 100)}`);
      }),
    };
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(db));
    loadPharmacyOrderCommandReceiptTx.mockResolvedValue({
      payload: { order: { id: 71 }, replayed: true },
    });

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid,
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: '1'.repeat(64),
      requestSha256: '2'.repeat(64),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_PRESCRIPTION_ORIGIN_MISMATCH',
    });

    expect(loadPharmacyOrderCommandReceiptTx).not.toHaveBeenCalled();
  });

  test('receipt replay remains unavailable after the patient is concurrently merged', async () => {
    const actorUid = '22222222-2222-4222-8222-222222222222';
    const db = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (/pg_advisory_xact_lock/.test(sql)) return [{ lock_acquired: null }];
        if (/SELECT id, uid, role/.test(sql)) {
          return [{ id: 22, uid: actorUid, role: 'PHARMACY_STAFF' }];
        }
        if (/FROM pharmacy_orders po/.test(sql)) {
          return [{
            id: 71,
            tenant_id: TENANT,
            facility_id: 7,
            patient_id: 91,
            patient_uid: PATIENT_UID,
            authority_origin: 'e_prescription',
          }];
        }
        if (/FROM e_prescriptions ep/.test(sql)) {
          return [{ id: 81, patient_id: 91, patient_uid: PATIENT_UID }];
        }
        if (/SELECT uid[\s\S]*FROM users/.test(sql)) return [];
        throw new Error(`Unexpected verifier patient replay SQL: ${sql.slice(0, 100)}`);
      }),
    };
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(db));
    loadPharmacyOrderCommandReceiptTx.mockResolvedValue({
      payload: { order: { id: 71 }, replayed: true },
    });

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid,
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: '3'.repeat(64),
      requestSha256: '4'.repeat(64),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_PATIENT_AUTHORITY_CHANGED',
    });

    expect(loadPharmacyOrderCommandReceiptTx).not.toHaveBeenCalled();
  });

  test('returns the persisted active-therapy hash when every authority is unchanged', async () => {
    const fixture = await verifiedFixture();
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(fixture.db));

    await expect(assertVerificationCleared(71, TENANT)).resolves.toEqual(
      expect.objectContaining({ active_therapy_sha256: 'a'.repeat(64) }),
    );
  });

  test('requires reconciliation when recomputation exposes an unresolved therapy', async () => {
    const fixture = await verifiedFixture();
    setTenantTx.mockImplementation(async (_tenantId, callback) => callback(fixture.db));
    loadActiveTherapySnapshot.mockResolvedValue({
      sha256: 'c'.repeat(64),
      blockers: [{ type: 'ACTIVE_THERAPY_TIMING_UNRESOLVED' }],
      evidence: [],
      medications: [],
    });

    await expect(assertVerificationCleared(71, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFY_ACTIVE_THERAPY_RECONCILIATION_REQUIRED',
    });
  });
});
