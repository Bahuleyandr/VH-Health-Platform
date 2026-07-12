import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
  setTenant: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
  })),
  setTenantTx: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
  })),
}));

jest.unstable_mockModule('../../services/billing/paymentLinkService.js', () => ({
  createPaymentLink: jest.fn(),
}));
jest.unstable_mockModule('../../services/gamification/pointService.js', () => ({
  getUserPointSummary: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));
jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  releaseVisibilitySql: jest.fn(() => 'TRUE'),
  releaseDelayHours: jest.fn(() => 0),
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/patientExplainersService.js', () => ({
  PATIENT_EXPLAINER_MODULE_KEYS: [],
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: jest.fn(),
}));

const { getMyBill } = await import('../../services/portal/patientPortalService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

describe('patient bill source reference wire shaping', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
  });

  it('serializes BIGINT source references without losing unsafe identifiers', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        invoice_number: 'INV-BIGINT-WIRE',
        issued_at: null,
        created_at: new Date('2026-07-12T09:00:00.000Z'),
        invoice_type: 'OP',
        status: 'DRAFT',
        subtotal: 300,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        discount_amount: 0,
        discount_reason: null,
        total_amount: 300,
        amount_paid: 0,
        amount_due: 300,
        patient_uid: PATIENT,
        patient_state: null,
        hospital_state: null,
        tenant_id: TENANT,
        admission_id: null,
      }])
      .mockResolvedValueOnce([
        {
          id: 11,
          description: 'Safe source reference',
          line_total: 100,
          source_ref_type: 'lab_order',
          source_ref_id: 42n,
          tpa_decision: null,
          tpa_non_payable_reason: null,
        },
        {
          id: 12,
          description: 'Unsafe source reference',
          line_total: 200,
          source_ref_type: 'cath_consumable_usage',
          source_ref_id: 9_007_199_254_740_993n,
          tpa_decision: null,
          tpa_non_payable_reason: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const bill = await getMyBill({
      tenantId: TENANT,
      patient_uid: PATIENT,
      id: 7,
    });

    expect(bill.items[0].source_ref_id).toBe(42);
    expect(bill.items[1].source_ref_id).toBe('9007199254740993');
    expect(() => JSON.stringify(bill)).not.toThrow();
  });
});
