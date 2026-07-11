// Unit test for addInvoiceItem's source_ref integrity guard.
// The guard fires before any DB access (no service_code path), so it is
// exercised without a database call. Finding 2026-05-20-tpa-insurance-claim-
// billing-013275c3: a source-backed line (room_day, lab_order, …) must carry
// a source_ref_id so the charge is auditable to its originating record.

import { jest } from '@jest/globals';

const prismaMock = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(prismaMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: setTenantTxMock,
}));

const { addInvoiceItem } = await import('../../services/billing/billingV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  prismaMock.$executeRawUnsafe.mockReset();
  prismaMock.$queryRawUnsafe.mockReset();
  setTenantTxMock.mockClear();
});

describe('billingV2Service.addInvoiceItem — source_ref integrity guard', () => {
  it('rejects a source-backed room_day line with no source_ref_id', async () => {
    await expect(
      addInvoiceItem(1, {
        description: 'IPD semi-private room, running charge',
        unit_price: 65000,
        source_ref_type: 'room_day',
        // source_ref_id deliberately omitted
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_REF_ID_REQUIRED' });
  });

  it('rejects an order-backed lab_order line with no source_ref_id', async () => {
    await expect(
      addInvoiceItem(1, {
        description: 'Complete blood count',
        unit_price: 300,
        source_ref_type: 'lab_order',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_REF_ID_REQUIRED' });
  });

  it.each([
    'cath_procedure_log',
    'cath_consumable_usage',
  ])('accepts %s as a bounded source type and requires its source id', async (sourceRefType) => {
    await expect(
      addInvoiceItem(1, {
        description: 'Cath-lab charge',
        unit_price: 100,
        source_ref_type: sourceRefType,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_REF_ID_REQUIRED' });
  });

  it.each([
    ['dialysis_session', 'dialysis_sessions'],
    ['cath_procedure_log', 'cath_procedure_logs'],
    ['cath_consumable_usage', 'cath_case_consumable_usage'],
  ])('rejects a %s source outside the invoice tenant/patient', async (sourceRefType, table) => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        status: 'DRAFT',
        patient_state: null,
        hospital_state: null,
        admission_id: null,
        patient_uid: PATIENT,
        tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([]);

    await expect(addInvoiceItem(17, {
      tenantId: TENANT,
      description: 'Bound source line',
      unit_price: 100,
      source_ref_type: sourceRefType,
      source_ref_id: 73,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_SOURCE_REF_MISMATCH',
    });

    const ownershipCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(ownershipCall[0]).toContain(`FROM ${table}`);
    expect(ownershipCall[0]).toContain('tenant_id = $2::uuid');
    expect(ownershipCall[0]).toContain('patient_uid = $3::uuid');
    expect(ownershipCall.slice(1)).toEqual([73, TENANT, PATIENT]);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('writes the verified invoice tenant explicitly for a valid cath source', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        status: 'DRAFT',
        patient_state: null,
        hospital_state: null,
        admission_id: null,
        patient_uid: PATIENT,
        tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([{ id: 73 }])
      .mockResolvedValueOnce([{ id: 91, source_ref_id: 73n, tenant_id: TENANT }])
      .mockResolvedValueOnce([{ subtotal: 100, cgst: 0, sgst: 0, igst: 0 }])
      .mockResolvedValueOnce([{ discount_amount: 0, amount_paid: 0 }])
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: PATIENT, tenant_id: TENANT }]);
    prismaMock.$executeRawUnsafe.mockResolvedValueOnce(1);

    await expect(addInvoiceItem(17, {
      tenantId: TENANT,
      description: 'Cath consumable',
      unit_price: 100,
      source_ref_type: 'cath_consumable_usage',
      source_ref_id: 73,
    })).resolves.toMatchObject({ source_ref_id: 73, tenant_id: TENANT });

    const insertCall = prismaMock.$queryRawUnsafe.mock.calls[2];
    expect(insertCall[0]).toContain('source_ref_id, tenant_id');
    expect(insertCall[0]).toContain('$17::uuid');
    expect(insertCall.at(-1)).toBe(TENANT);
  });
});
