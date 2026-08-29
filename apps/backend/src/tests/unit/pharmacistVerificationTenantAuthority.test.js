import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const setTenantTx = jest.fn();
const validatePrescriptionSafety = jest.fn();
const loadActiveTherapySnapshot = jest.fn();
const loadDrugKbRevision = jest.fn();
const recordCanonicalClinicalEvent = jest.fn();
const recordMedicationSafetyReviews = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  setTenantTx,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  loadActiveTherapySnapshot,
  validatePrescriptionSafety,
}));
jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: jest.fn(),
  loadDrugKbRevision,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
}));

const {
  assertVerificationCleared,
  clinicalOrderItemsSha256,
  ensurePackBarcode,
  getPackLabel,
  orderItemsToMedications,
  verifyOrder,
} = await import('../../services/pharmacy/pharmacistVerificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  setTenantTx.mockImplementation(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
  }));
  executeRawUnsafe.mockResolvedValue(1);
  validatePrescriptionSafety.mockResolvedValue({ safe: true, blockers: [], warnings: [] });
  loadActiveTherapySnapshot.mockResolvedValue({
    sha256: 'a'.repeat(64), blockers: [], evidence: [], medications: [],
  });
  loadDrugKbRevision.mockResolvedValue(1);
  recordCanonicalClinicalEvent.mockResolvedValue({ id: 1 });
  recordMedicationSafetyReviews.mockResolvedValue([]);
});

describe('pharmacist verification tenant authority', () => {
  test('verification lookup cannot see an order outside the request tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(verifyOrder(71, { tenantId: TENANT }))
      .rejects.toMatchObject({ statusCode: 404 });

    const [sql, orderId, tenantId] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('po.tenant_id = $2::uuid');
    expect(sql).toContain('u.tenant_id = po.tenant_id');
    expect(sql).toContain("u.role = 'PATIENT'");
    expect(sql).toContain('(po.patient_id IS NULL OR u.uid IS NOT NULL)');
    expect([orderId, tenantId]).toEqual([71, TENANT]);
  });

  test('pack-label lookup fails closed under the same tenant predicate', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(getPackLabel(71, TENANT))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(queryRawUnsafe.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafe.mock.calls[0][0]).toMatch(/facility_id = \([\s\S]*facilities/);
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual([71, TENANT]);
  });

  test('barcode recovery update is tenant-bound and non-enumerating', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(ensurePackBarcode(71, TENANT))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(queryRawUnsafe.mock.calls[0][0]).toContain('tenant_id = $3::uuid');
    expect(queryRawUnsafe.mock.calls[0][1]).toBe(71);
    expect(queryRawUnsafe.mock.calls[0][3]).toBe(TENANT);
  });

  test('cleared status is rejected when the verified version or item snapshot is stale', async () => {
    const items = [{
      order_line_index: 0,
      prescription_line_index: 0,
      catalog_id: 17,
      name: 'Drug A',
      ordered_qty: 2,
    }];
    queryRawUnsafe.mockResolvedValueOnce([{
      clinical_verification_status: 'verified',
      items_list: items,
      inventory_authority_version: 4,
      clinically_verified_order_version: 3,
      clinical_verification_items_sha256: clinicalOrderItemsSha256(items),
    }]);

    await expect(assertVerificationCleared(71, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    expect(queryRawUnsafe.mock.calls[0][0]).toMatch(/tenant_id = \$2::uuid/);
    expect(queryRawUnsafe.mock.calls[0][0]).toMatch(/facility_id = \([\s\S]*facilities/);
  });

  test('the clinical snapshot hash includes stable line identity and ordered quantity', () => {
    const base = [{
      order_line_index: 0,
      prescription_line_index: 0,
      catalog_id: 17,
      name: 'Drug A',
      ordered_qty: 2,
    }];
    const quantityChanged = [{ ...base[0], ordered_qty: 3 }];
    const identityChanged = [{ ...base[0], prescription_line_index: 1 }];

    expect(clinicalOrderItemsSha256(base)).not.toBe(clinicalOrderItemsSha256(quantityChanged));
    expect(clinicalOrderItemsSha256(base)).not.toBe(clinicalOrderItemsSha256(identityChanged));
  });

  test('verification medication projection preserves the authoritative catalog identity', () => {
    expect(orderItemsToMedications([{
      catalog_id: 17,
      name: 'Drug A',
      dosage: '500 mg',
    }])).toEqual([expect.objectContaining({
      catalog_id: 17,
      name: 'Drug A',
      dose: '500 mg',
    })]);
  });

  test('verification persists only through tenant, facility, version, and item-snapshot CAS', async () => {
    const items = [{
      order_line_index: 0,
      prescription_line_index: 0,
      catalog_id: 17,
      name: 'Drug A',
      ordered_qty: 2,
    }];
    queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 71,
        order_number: 'PO-71',
        status: 'CONFIRMED',
        patient_id: 91,
        patient_uid: '11111111-1111-4111-8111-111111111111',
        patient_name: 'Patient',
        items_list: items,
        tenant_id: TENANT,
        facility_id: 7,
        inventory_authority_version: 4,
        clinical_verification_status: 'pending',
      }])
      .mockResolvedValueOnce([{ version: 9 }])
      .mockResolvedValueOnce([{
        id: 71,
        order_number: 'PO-71',
        status: 'CONFIRMED',
        patient_id: 91,
        patient_uid: '11111111-1111-4111-8111-111111111111',
        patient_name: 'Patient',
        items_list: items,
        tenant_id: TENANT,
        facility_id: 7,
        inventory_authority_version: 4,
        clinical_verification_status: 'pending',
      }])
      .mockResolvedValueOnce([]);

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid: '22222222-2222-4222-8222-222222222222',
      actorRole: 'PHARMACY_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFY_STATE_CHANGED',
    });

    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(executeRawUnsafe.mock.calls[0][0]).toMatch(
      /INSERT INTO pharmacy_patient_safety_versions[\s\S]*ON CONFLICT/,
    );
    expect(executeRawUnsafe.mock.calls[0].slice(1)).toEqual([TENANT, 91]);
    expect(queryRawUnsafe.mock.calls[1][0]).toMatch(
      /pharmacy_patient_safety_versions[\s\S]*tenant_id=\$1::uuid[\s\S]*patient_id=\$2::int[\s\S]*FOR UPDATE/,
    );
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual([TENANT, 91]);
    expect(validatePrescriptionSafety).toHaveBeenCalledWith(
      91,
      [expect.objectContaining({ catalog_id: 17, name: 'Drug A' })],
      { tenantId: TENANT },
    );
    const update = queryRawUnsafe.mock.calls[3];
    expect(update[0]).toMatch(/tenant_id = \$8::uuid/);
    expect(update[0]).toMatch(/facility_id = \$11::int/);
    expect(update[0]).toMatch(/inventory_authority_version = \$6::int/);
    expect(update[0]).toMatch(/items_list IS NOT DISTINCT FROM \$10::jsonb/);
    expect(update[0]).toMatch(/clinical_verification_safety_version = \$12::bigint/);
    expect(update[6]).toBe(4);
    expect(update[8]).toBe(TENANT);
    expect(update[10]).toBe(JSON.stringify(items));
    expect(update[11]).toBe(7);
    expect(update[12]).toBe(9);
    expect(recordMedicationSafetyReviews).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('a changed patient safety version invalidates an otherwise matching verification', async () => {
    const items = [{
      order_line_index: 0,
      prescription_line_index: 0,
      catalog_id: 17,
      name: 'Drug A',
      ordered_qty: 2,
    }];
    queryRawUnsafe.mockResolvedValueOnce([{
      patient_id: 91,
      clinical_verification_status: 'verified',
      items_list: items,
      inventory_authority_version: 4,
      clinically_verified_order_version: 4,
      clinical_verification_items_sha256: clinicalOrderItemsSha256(items),
      clinical_verification_safety_version: 8,
      current_safety_version: 9,
    }]);

    await expect(assertVerificationCleared(71, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    expect(queryRawUnsafe.mock.calls[0][0]).toMatch(
      /LEFT JOIN pharmacy_patient_safety_versions psv[\s\S]*psv\.tenant_id=po\.tenant_id[\s\S]*psv\.patient_id=po\.patient_id/,
    );
  });

  test('pack-label fails before reading or issuing a barcode when verification provenance is stale', async () => {
    const items = [{
      order_line_index: 0,
      catalog_id: 17,
      name: 'Drug A',
      ordered_qty: 2,
    }];
    queryRawUnsafe.mockResolvedValueOnce([{
      clinical_verification_status: 'verified',
      items_list: items,
      inventory_authority_version: 4,
      clinically_verified_order_version: 4,
      clinical_verification_items_sha256: 'stale-hash',
    }]);

    await expect(getPackLabel(71, TENANT)).rejects.toMatchObject({
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe.mock.calls[0][0]).toMatch(/FOR UPDATE/);
  });
});
